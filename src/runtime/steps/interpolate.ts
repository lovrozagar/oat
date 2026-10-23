/*
 * `{name}` placeholders in a step's path, body, headers and query, filled from the scope the steps
 * before it bound. A name the scope lacks stays as written here; the request a step sends refuses it.
 */

import { isBytes, PLACEHOLDER } from "../../config/types/placeholder.ts"

/** `value` with every `{name}` in its text replaced from `scope`, walking arrays and objects. */
export function interpolate(value: unknown, scope: Record<string, string>): unknown {
	if (typeof value === "string") {
		return value.replace(PLACEHOLDER, (match, key: string) => scope[key] ?? match)
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, scope))
	if (isBytes(value)) return value
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = interpolate(item, scope)
		}
		return out
	}
	return value
}
