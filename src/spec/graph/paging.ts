import type { OperationModel, SpecModel } from "./types.ts"

/**
 * The largest page a list operation documents, and the parameter that asks for it.
 *
 * `x-query`'s `maxLimit` first, then the page-size parameter's schema `maximum`, then a
 * conventional 100 where the document states no bound. A request above the documented maximum is
 * the caller breaking the contract, and a backend is right to refuse it. `param` is undefined when
 * the operation has no page-size parameter at all — then no size can be asked for.
 */
export function documentedPage(model: SpecModel, op: OperationModel): { param: string | undefined; size: number } {
	const param = op.conventions.limit
	if (op.query?.maxLimit !== undefined) return { param, size: op.query.maxLimit }
	const raw = model.rawOperations.get(op.operationId)
	const declared = (raw?.parameters ?? []).find(
		(candidate) => "name" in candidate && candidate.in === "query" && candidate.name === param,
	) as { schema?: { maximum?: unknown } } | undefined
	const max = declared?.schema?.maximum
	return { param, size: typeof max === "number" && max >= 1 ? max : 100 }
}

/** The query that asks an operation for its largest documented page. */
export function largestPageQuery(model: SpecModel, op: OperationModel): Record<string, number> {
	const { param, size } = documentedPage(model, op)
	return param === undefined ? {} : { [param]: size }
}
