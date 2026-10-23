/*
 * The `{name}` placeholder grammar every step, recipe and scenario shares. A name is letters,
 * digits and `_`, with a single `-` between them, as path parameters and the saveAs names copied
 * from them (`user-id`) are written. The three patterns below spell that one name alike.
 */

/** Every `{name}` in a text. */
export const PLACEHOLDER: RegExp = /\{([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)\}/g

/** A text that is nothing but one `{name}`. */
export const WHOLE_PLACEHOLDER: RegExp = /^\{([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)\}$/

/** Every `{principal.<key>}` in a text: the principal's identity, filled apart from the flow scope. */
export const PRINCIPAL_PLACEHOLDER: RegExp = /\{principal\.([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)\}/g

/** Bytes are a file's content, not text to fill: walking them would turn an upload into JSON. */
export function isBytes(value: unknown): value is ArrayBuffer | ArrayBufferView | Blob {
	return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob
}

/** Every `{name}` in the text of a value, deep through arrays and objects, in order; bytes hold none. */
export function placeholderNames(value: unknown): string[] {
	if (typeof value === "string") return [...value.matchAll(PLACEHOLDER)].map(([, name]) => name as string)
	if (Array.isArray(value)) return value.flatMap(placeholderNames)
	if (isBytes(value) || value === null || typeof value !== "object") return []
	return Object.values(value).flatMap(placeholderNames)
}
