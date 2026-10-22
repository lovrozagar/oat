/** The operations a document declares, each with its method, path and the parameters it inherits. */

import { PATH_ITEM_METHODS } from "./methods.ts"
import type { Endpoint, OpenApiDocument, OperationObject, ParameterObject } from "./types.ts"

export function listEndpoints(doc: OpenApiDocument): Endpoint[] {
	const out: Endpoint[] = []
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		if (item === null || typeof item !== "object") continue
		for (const method of PATH_ITEM_METHODS) {
			const op = (item as Record<string, unknown>)[method]
			if (op === null || typeof op !== "object") continue
			const operation = withPathParameters(op as OperationObject, (item as { parameters?: unknown }).parameters)
			out.push({
				method,
				op: operation,
				operationId: operation.operationId ?? `${method.toUpperCase()} ${path}`,
				path,
			})
		}
	}
	return out
}

function key(p: { name?: unknown; in?: unknown }): string {
	return `${String(p.in)}:${String(p.name)}`
}

/**
 * An operation with its path item's `parameters` folded in.
 *
 * A path item may declare parameters once for every operation under it, and an operation may
 * override one by name and location. Reading only the operation's own list lost every shared
 * path parameter, and with it the declared schema of each identifier.
 */
function withPathParameters(op: OperationObject, shared: unknown): OperationObject {
	if (!Array.isArray(shared) || shared.length === 0) return op
	const own = op.parameters ?? []
	const overridden = new Set(own.map(key))
	const inherited = (shared as ParameterObject[]).filter(
		(parameter) => parameter !== null && typeof parameter === "object" && !overridden.has(key(parameter)),
	)
	return inherited.length === 0 ? op : { ...op, parameters: [...inherited, ...own] }
}
