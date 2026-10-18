/*
 * `{name}` placeholders in a step's path, body, headers and query, filled from the scope the steps
 * before it bound. A name the scope lacks stays as written, so a typo shows up in the request.
 */

/** Bytes are a file's content, not text to fill: walking them would turn an upload into JSON. */
export function isBytes(value: unknown): value is ArrayBuffer | ArrayBufferView | Blob {
	return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob
}

/** `value` with every `{name}` in its text replaced from `scope`, walking arrays and objects. */
export function interpolate(value: unknown, scope: Record<string, string>): unknown {
	if (typeof value === "string") {
		return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => scope[key] ?? match)
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
