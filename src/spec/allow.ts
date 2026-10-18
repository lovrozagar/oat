/**
 * The only operations a run may call.
 *
 * Everything else leaves the document before oat reads it, so the matrix, the contract floor,
 * scenarios and teardown cannot reach it: there is nothing to forget to check, because the
 * operation does not exist as far as oat knows. A config that still needs a removed operation —
 * an auth step, a scenario step — is told so before anything is sent.
 */

import type { Principal } from "../config/types/principals.ts"
import type { Scenario } from "../config/types/steps.ts"
import { UsageError } from "../errors/usage-error.ts"
import type { OpenApiDocument } from "./types.ts"

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export function pruneToAllow(
	doc: OpenApiDocument,
	allow: readonly string[],
): { doc: OpenApiDocument; removed: string[] } {
	const kept = new Set(allow)
	const out = structuredClone(doc)
	const paths = (out.paths ?? {}) as Record<string, unknown>
	const seen = new Set<string>()
	const removed: string[] = []
	for (const [route, item] of Object.entries(paths)) {
		if (!isRecord(item)) continue
		for (const method of METHODS) {
			const op = item[method]
			if (!isRecord(op)) continue
			const id = typeof op.operationId === "string" ? op.operationId : `${method.toUpperCase()} ${route}`
			seen.add(id)
			if (kept.has(id)) continue
			removed.push(id)
			delete item[method]
		}
		if (!METHODS.some((method) => isRecord(item[method]))) delete paths[route]
	}
	const unknown = allow.filter((id) => !seen.has(id))
	if (unknown.length > 0) {
		throw new UsageError(`allow names ${unknown.map((id) => `"${id}"`).join(", ")}, which the document does not have`)
	}
	return { doc: out, removed: removed.sort() }
}

/** The operations `steps` call on the document itself that the allowlist removed. */
function removedCalls(kept: ReadonlySet<string>, steps: readonly object[]): string[] {
	return steps
		.filter((step): step is { operationId: string; origin?: unknown } => "operationId" in step)
		.filter((step) => step.origin === undefined && !kept.has(step.operationId))
		.map((step) => step.operationId)
}

function principalProblems(kept: ReadonlySet<string>, principal: Principal): string[] {
	const auth = principal.auth
	if (auth === undefined || !("steps" in auth)) return []
	const steps = [...auth.steps, ...(auth.refresh?.steps ?? [])]
	return removedCalls(kept, steps).map((id) => `principal "${principal.id}" auth step "${id}"`)
}

function scenarioProblems(kept: ReadonlySet<string>, scenario: Scenario): string[] {
	if (scenario.origin !== undefined) return []
	return [
		...removedCalls(kept, scenario.steps).map((id) => `scenario "${scenario.id}" step "${id}"`),
		...scenario.covers.filter((id) => !kept.has(id)).map((id) => `scenario "${scenario.id}" covers "${id}"`),
	]
}

/** Every operation the config itself will call by name must survive the allowlist. */
export function assertAllowedReferences(
	kept: ReadonlySet<string>,
	config: { principals?: readonly Principal[]; scenarios?: readonly Scenario[] },
): void {
	const problems = [
		...(config.principals ?? []).flatMap((principal) => principalProblems(kept, principal)),
		...(config.scenarios ?? []).flatMap((scenario) => scenarioProblems(kept, scenario)),
	]
	if (problems.length > 0) {
		throw new UsageError(`allow removes operations the config still calls: ${[...new Set(problems)].join("; ")}`)
	}
}
