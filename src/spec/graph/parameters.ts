/** What an operation's parameters promise a request: required query values and an idempotency key. */

import type { OperationObject, ParameterObject } from "../types.ts"

/** The value a parameter's document gives it: an example first, then a const, enum, or default. */
function declaredValue(param: ParameterObject): string | undefined {
	const schema = param.schema ?? {}
	const named = param["examples"]
	const fromNamed =
		named !== null && typeof named === "object"
			? Object.values(named as Record<string, { value?: unknown }>).find((entry) => entry?.value !== undefined)?.value
			: undefined
	const listed = Array.isArray(schema["examples"]) ? (schema["examples"] as unknown[])[0] : undefined
	const enumerated = Array.isArray(schema["enum"]) ? (schema["enum"] as unknown[])[0] : undefined
	const value = [
		param["example"],
		fromNamed,
		listed,
		schema["example"],
		schema["const"],
		enumerated,
		schema["default"],
	].find((candidate) => candidate !== undefined && candidate !== null && typeof candidate !== "object")
	return value === undefined ? undefined : String(value)
}

/**
 * Required query parameters and the value the document declares for each. A parameter with no
 * declared value is left to the caller, never invented.
 */
export function readRequiredQuery(parameters: readonly ParameterObject[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const param of parameters) {
		if (param.in !== "query" || param.required !== true) continue
		const value = declaredValue(param)
		if (value !== undefined) out[param.name] = value
	}
	return out
}

/** The header parameter `op` accepts as an idempotency key, when it declares one. */
export function idempotencyHeader(op: OperationObject): string | null {
	return (
		(op.parameters ?? []).find(
			(p) => p.in === "header" && /^(x-)?idempotenc(y|e)([-_]?key)?$/i.test(p.name.replace(/\s/g, "")),
		)?.name ?? null
	)
}

/**
 * Header names the operation's success response declares.
 *
 * Pagination facts do not always live in the body — `Link` is the obvious case — so a header the
 * document publishes is part of the response contract and has to be read as such.
 */
export function successResponseHeaders(op: OperationObject): string[] {
	const responses = (op.responses ?? {}) as Record<string, { headers?: Record<string, unknown> }>
	const names = new Set<string>()
	for (const [status, response] of Object.entries(responses)) {
		if (!/^2\d\d$/.test(status)) continue
		for (const name of Object.keys(response?.headers ?? {})) names.add(name)
	}
	return [...names]
}
