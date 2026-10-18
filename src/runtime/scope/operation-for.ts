import { pathTemplateMatches } from "../../spec/routes.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"

/** The operation an exchange hit, preferring literal segments over parameters on a tie. */
export function operationFor(
	model: SpecModel,
	exchange: Pick<Exchange, "method" | "url">,
	baseUrl: string,
): OperationModel | null {
	const { method, url } = exchange
	let pathname: string
	let basePath: string
	try {
		pathname = new URL(url).pathname
		basePath = new URL(baseUrl).pathname.replace(/\/$/, "")
	} catch {
		return null
	}
	const local = basePath !== "" && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
	let best: OperationModel | null = null
	let bestParams = Number.POSITIVE_INFINITY
	for (const op of model.operations) {
		if (op.method.toUpperCase() !== method.toUpperCase()) continue
		if (!pathTemplateMatches(op.path, local) && !pathTemplateMatches(op.path, pathname)) continue
		if (op.pathParams.length < bestParams) {
			best = op
			bestParams = op.pathParams.length
		}
	}
	return best
}
