/**
 * The cursor a list response gives for its next page, as the next request sends it. A server may give
 * it as text or as a number (a `created_at` keyset, a row id); either is sent back as text. Anything
 * else, an empty string or null included, means no next page.
 */
export function nextCursorOf(value: unknown): string | undefined {
	if (typeof value === "string") return value === "" ? undefined : value
	return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined
}
