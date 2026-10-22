import { pathTemplateParams } from "../routes.ts"
import type { ParamStyles } from "./parameters.ts"
import type { OperationModel, SpecModel } from "./types.ts"

/** The documented operation a request instances, with the path parameters it carries. */
export interface ResolvedOperation {
	operationId: string
	template: string
	entity: string | null
	redirects: boolean
	requiredQuery: Record<string, unknown>
	requiredHeaders: Record<string, unknown>
	requiredCookies: Record<string, unknown>
	paramStyles: ParamStyles
	pathParams: Record<string, string>
}

/**
 * Maps a request (method + path below the base URL) to the documented operation it instances.
 *
 * Literal segments beat parameters where two templates match — `/tables/archived` is not
 * `/tables/{id}` — so the most specific template wins.
 */
export function operationResolver(
	model: SpecModel,
): (method: string, relativePath: string) => ResolvedOperation | null {
	const candidates = [...model.operations].sort(
		(a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0),
	)
	return (method, relativePath) => {
		const verb = method.toUpperCase()
		for (const op of candidates) {
			if (op.method.toUpperCase() !== verb) continue
			const pathParams = pathTemplateParams(op.path, relativePath)
			if (pathParams !== null) return resolvedTo(op, pathParams)
		}
		return null
	}
}

function resolvedTo(op: OperationModel, pathParams: Record<string, string>): ResolvedOperation {
	/* A documented 3xx is the answer to grade, not a hop to follow. */
	const redirects = op.statuses.exact.some((code) => code >= 300 && code < 400) || op.statuses.ranges.includes(3)
	return {
		entity: op.entity,
		operationId: op.operationId,
		pathParams,
		paramStyles: op.paramStyles,
		redirects,
		requiredCookies: op.requiredCookies,
		requiredHeaders: op.requiredHeaders,
		requiredQuery: op.requiredQuery,
		template: op.path,
	}
}
