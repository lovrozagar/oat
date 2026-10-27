/*
 * `{name}` placeholders in a step's path, body, headers and query, filled from the scope the steps
 * before it bound. A name the scope lacks stays as written here; the request a step sends refuses it.
 * A field that is exactly `{name}` of a kept value (an object a response or a hook handed back, a
 * number, a boolean) is that value itself, sent as it is: text inside it is never read as a
 * placeholder, so a URL template it carries goes byte for byte.
 */

import { isBytes, PLACEHOLDER, WHOLE_PLACEHOLDER } from "../../config/types/placeholder.ts"

/** `value` with every `{name}` in its text replaced from `scope`, and each kept value whole, walking arrays and objects. */
export function interpolate(
	value: unknown,
	scope: Record<string, string>,
	kept: ReadonlyMap<string, unknown> = new Map(),
): unknown {
	if (typeof value === "string") {
		const whole = WHOLE_PLACEHOLDER.exec(value)?.[1]
		if (whole !== undefined && kept.has(whole)) return kept.get(whole)
		return value.replace(PLACEHOLDER, (match, key: string) => scope[key] ?? match)
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, scope, kept))
	if (isBytes(value)) return value
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = interpolate(item, scope, kept)
		}
		return out
	}
	return value
}
