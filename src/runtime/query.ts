/** Query parameters as checks build them; an array value is sent as one parameter per item. */
export type QueryParams = Record<string, string | readonly string[]>

/**
 * Two sets of query parameters as one.
 *
 * A grammar that repeats its filter parameter for every term needs both terms sent, so `repeat`
 * appends a key both sides carry. Otherwise the later value wins, which is what merging by
 * object spread has always meant.
 */
export function mergeQuery(a: QueryParams, b: QueryParams, repeat: boolean): QueryParams {
	if (!repeat) return { ...a, ...b }
	const merged: Record<string, string | readonly string[]> = { ...a }
	for (const [key, value] of Object.entries(b)) {
		const before = merged[key]
		merged[key] = before === undefined ? value : [...asList(before), ...asList(value)]
	}
	return merged
}

function asList(value: string | readonly string[]): readonly string[] {
	return typeof value === "string" ? [value] : value
}
