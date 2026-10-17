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

/** Every operation the config itself will call by name must survive the allowlist. */
export function assertAllowedReferences(
	kept: ReadonlySet<string>,
	config: { principals?: readonly Principal[]; scenarios?: readonly Scenario[] },
): void {
	const problems: string[] = []
	for (const principal of config.principals ?? []) {
		const auth = principal.auth
		if (auth === undefined || !("steps" in auth)) continue
		const steps = [...auth.steps, ...(auth.refresh?.steps ?? [])]
		for (const step of steps) {
			if ("operationId" in step && step.origin === undefined && !kept.has(step.operationId)) {
				problems.push(`principal "${principal.id}" auth step "${step.operationId}"`)
			}
		}
	}
	for (const scenario of config.scenarios ?? []) {
		if (scenario.origin !== undefined) continue
		for (const step of scenario.steps) {
			if ("operationId" in step && step.origin === undefined && !kept.has(step.operationId)) {
				problems.push(`scenario "${scenario.id}" step "${step.operationId}"`)
			}
		}
		for (const id of scenario.covers) {
			if (!kept.has(id)) problems.push(`scenario "${scenario.id}" covers "${id}"`)
		}
	}
	if (problems.length > 0) {
		throw new UsageError(`allow removes operations the config still calls: ${[...new Set(problems)].join("; ")}`)
	}
}
