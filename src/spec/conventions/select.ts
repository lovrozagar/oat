import type { QueryConventions } from "./types.ts"

/**
 * Renders a sparse fieldset, returning the parameter name alongside the value.
 *
 * JSON:API puts the resource type in the parameter name rather than the value, so the two cannot
 * be chosen independently — which is why this returns a pair rather than a string.
 */
export function selectTerm(
	conventions: QueryConventions,
	fields: readonly string[],
	resource: string,
): Record<string, string> | null {
	const parameter = conventions.select
	if (parameter === undefined) return null
	const value = fields.join(",")
	if (conventions.selectGrammar === "csv") return { [parameter]: value }
	/* Already bracketed in the document — `fields[articles]` — so the name is used verbatim.
	 * Otherwise the resource name is inserted, which is what the grammar requires. */
	const name = /\[[^\]]+\]$/.test(parameter) ? parameter : `${parameter}[${resource}]`
	return { [name]: value }
}
