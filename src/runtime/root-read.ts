/**
 * `x-entity.identity: root` — the path id is the signed-up caller's root.
 * No list and no create. No token is a 401. The authed read uses that root.
 */

import type { Check } from "./checks/core/check.ts"
import type { Client } from "../client/client.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import type { CheckId } from "./check-ids.ts"
import type { EntityModel, SpecModel } from "../spec/graph.ts"
import { fillPath } from "./fill-path.ts"

export const ROOT_READ_CHECK_ID = "read.matches-caller-root" as const satisfies CheckId

export function rootReadIds(entity: EntityModel): string[] {
	if (entity.identity !== "root") return []
	if (entity.reads !== undefined && entity.reads.length > 0) return entity.reads
	return entity.read === undefined ? [] : [entity.read]
}

export async function runRootRead(input: {
	auth: () => Record<string, string>
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
		let path: string
		try {
			path = fillPath(op.path, input.roots)
		} catch {
			return findings.unresolved(ROOT_READ_CHECK_ID, input.entity.name, `${op.operationId} needs a path id`)
		}
		const query = dateWindow(op.queryParamNames)
		const anonymous = await input.client.request(op.method, path, {
			headers: {},
			operationId: op.operationId,
			...(query === undefined ? {} : { query }),
			skipAuthRefresh: true,
		})
		if (anonymous.status !== 401) {
			return findings.security(
				ROOT_READ_CHECK_ID,
				input.entity.name,
				"the parent read answered without a token",
				`${op.operationId} returned ${anonymous.status} with no credential.`,
				[anonymous],
			)
		}
		const read = await input.client.request(op.method, path, {
			headers: input.auth,
			operationId: op.operationId,
			...(query === undefined ? {} : { query }),
		})
		if (read.status !== 200) {
			return findings.backend(
				ROOT_READ_CHECK_ID,
				input.entity.name,
				"the parent read failed",
				`${op.operationId} returned ${read.status} for ${path}.`,
				[anonymous, read],
			)
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
