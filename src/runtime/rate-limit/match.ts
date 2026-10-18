/** How a rate-limit `match` string, or a documented operation, decides which requests it covers. */

import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"

/** `operationId` is the operation the client stamped on the request, when it resolved one. */
export type RequestTest = (method: string, pathname: string, operationId?: string) => boolean

/**
 * Turns a path template or a simple glob into an anchored regex.
 *
 * `{param}` segments (from an operation's own path template) and bare `*` segments (from a
 * user-written pattern) both become `[^/]+`; `*` inside a segment becomes `[^/]*` so `item-*`
 * matches a prefix without crossing a `/`. Deliberately not a full glob or regex language — the
 * point of a config-level matcher is that it needs no coordination with the document, and a
 * bigger grammar would need documenting on both ends.
 */
export function compilePathPattern(pattern: string): RegExp {
	const compiled = pattern
		.split("/")
		.map((segment) => {
			if (segment === "*" || (segment.startsWith("{") && segment.endsWith("}"))) return "[^/]+"
			return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
		})
		.join("/")
	return new RegExp(`^${compiled}$`)
}

/**
 * A rule for one operation. A request the client resolved to an operation matches by that
 * operationId alone; only a request it could not resolve — an absolute URL off the document —
 * falls back to comparing method and path.
 */
export function operationTest(op: OperationModel): RequestTest {
	const pathRegex = compilePathPattern(op.path)
	const method = op.method.toUpperCase()
	return (m, p, operationId) =>
		operationId !== undefined ? operationId === op.operationId : m === method && pathRegex.test(p)
}

/** Compiles one `match` string against the model — an operationId, a path pattern, or a category. */
export function compileMatch(match: string, model: SpecModel): Array<{ test: RequestTest; category: string }> {
	if (match.startsWith("category:")) {
		const category = match.slice("category:".length).trim()
		return model.operations
			.filter((op) => op.rateLimit?.category === category)
			.map((op) => ({ category, test: operationTest(op) }))
	}

	const op = model.byOperationId.get(match)
	if (op !== undefined) return [{ category: match, test: operationTest(op) }]

	/* "METHOD /pattern" or a bare "/pattern" matching any method. */
	const spaceAt = match.indexOf(" ")
	const methodPart = spaceAt === -1 ? null : match.slice(0, spaceAt).toUpperCase()
	const pathPart = spaceAt === -1 ? match : match.slice(spaceAt + 1)
	const pathRegex = compilePathPattern(pathPart)
	return [
		{
			category: match,
			test: (m: string, p: string) => (methodPart === null || methodPart === m) && pathRegex.test(p),
		},
	]
}
