/**
 * `x-entity.identity: root` — the path id is the signed-up caller's root.
 * No list and no create. No token is a 401. The authed read uses that root.
 */

import type { Check } from "./checks/core/check.ts"
import type { Client } from "../client/client.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import type { CheckId } from "./check-ids.ts"
import type { EntityModel, SpecModel } from "../spec/graph/types.ts"
import { fillPath } from "./fill-path.ts"
import { noSecurityReason } from "./no-security.ts"

export const ROOT_READ_CHECK_ID: Extract<CheckId, "read.matches-caller-root"> = "read.matches-caller-root"

export function rootReadIds(entity: EntityModel): string[] {
	if (entity.identity !== "root") return []
	if (entity.reads !== undefined && entity.reads.length > 0) return entity.reads
	return entity.read === undefined ? [] : [entity.read]
}

export async function runRootRead(input: {
	/** The principal it sends as: `as: { principal }`, the operation's security choosing the scheme. */
	principal: string
	client: Client
	entity: EntityModel
	findings: FindingCollector
	model: SpecModel
	roots: Record<string, string>
}): Promise<Outcome> {
	const ids = rootReadIds(input.entity)
	const findings = input.findings.attributed(ids).ownedBy(ROOT_READ_CHECK_ID)
	for (const id of ids) {
		const op = input.model.byOperationId.get(id)
		if (op === undefined) continue
		const undeclared = noSecurityReason(op)
		if (undeclared !== undefined) return findings.unresolved(ROOT_READ_CHECK_ID, input.entity.name, undeclared)
		let path: string
		try {
			path = fillPath(op.path, input.roots)
		} catch {
			return findings.unresolved(ROOT_READ_CHECK_ID, input.entity.name, `${op.operationId} needs a path id`)
		}
		const query = dateWindow(op.queryParamNames)
		const anonymous = await input.client.request(op.method, path, {
			as: { anonymous: true },
			operationId: op.operationId,
			probe: true,
			...(query === undefined ? {} : { query }),
		})
		if (anonymous.status !== 401) {
			return findings.security(ROOT_READ_CHECK_ID, input.entity.name, {
				summary: "the parent read answered without a token",
				detail: `${op.operationId} returned ${anonymous.status} with no credential.`,
				evidence: [anonymous],
			})
		}
		const read = await input.client.request(op.method, path, {
			as: { principal: input.principal },
			operationId: op.operationId,
			...(query === undefined ? {} : { query }),
		})
		if (read.status !== 200) {
			return findings.backend(ROOT_READ_CHECK_ID, input.entity.name, {
				summary: "the parent read failed",
				detail: `${op.operationId} returned ${read.status} for ${path}.`,
				evidence: [anonymous, read],
			})
		}
	}
	return ASSERTED
}

/** `from` is a week before `to` when a read asks for both. */
function dateWindow(names: readonly string[]): Record<string, string> | undefined {
	if (!names.includes("from") || !names.includes("to")) return undefined
	const to = new Date()
	const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
	return { from: from.toISOString(), to: to.toISOString() }
}

export const rootReadCheck: Check = {
	id: ROOT_READ_CHECK_ID,
	needs: "x-entity.identity: root and a read",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* The entity loop calls `runRootRead` and returns. This entry keeps the id registered. */
	subjects: () => [],
}
