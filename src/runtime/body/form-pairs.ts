/** Form fields as the key/value pairs a urlencoded body sends. */

import type { FieldEncoding } from "./types.ts"

function scalar(item: unknown): string {
	return item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)
}

function delimiterOf(style: string): string {
	if (style === "spaceDelimited") return " "
	return style === "pipeDelimited" ? "|" : ","
}

/** How a field is serialized: its `style`, and whether it is exploded. */
interface Serialization {
	style: string
	explode: boolean
}

/** An object field: `name[key]` under deepObject, its own keys when exploded, one joined pair otherwise. */
function objectPairs(name: string, value: object, { style, explode }: Serialization): Array<[string, string]> {
	const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
	if (style === "deepObject") return entries.map(([key, item]) => [`${name}[${key}]`, scalar(item)])
	if (explode) return entries.map(([key, item]) => [key, scalar(item)])
	return [[name, entries.flatMap(([key, item]) => [key, scalar(item)]).join(",")]]
}

/**
 * One form field as the key/value pairs the operation's `encoding` says it becomes.
 *
 * The OpenAPI default for a form is `style: form, explode: true`: an array repeats its key per
 * item, an object spreads its properties as keys of their own. `deepObject` writes `name[key]`;
 * `explode: false` joins with the style's delimiter; a JSON `contentType` sends the value as JSON.
 */
export function formPairs(name: string, value: unknown, encoding: FieldEncoding | undefined): Array<[string, string]> {
	if (value === undefined || value === null) return []
	if (encoding?.contentType?.includes("json") === true) return [[name, JSON.stringify(value)]]
	const explode = encoding?.explode ?? true
	const style = encoding?.style ?? "form"
	if (Array.isArray(value)) {
		if (explode) return value.map((item) => [name, scalar(item)])
		return [[name, value.map(scalar).join(delimiterOf(style))]]
	}
	if (typeof value === "object") return objectPairs(name, value, { explode, style })
	return [[name, String(value)]]
}

export function encodeUrlencoded(
	fields: Record<string, unknown>,
	encoding?: Record<string, FieldEncoding>,
): URLSearchParams {
	const params = new URLSearchParams()
	for (const [name, value] of Object.entries(fields)) {
		for (const [key, item] of formPairs(name, value, encoding?.[name])) params.append(key, item)
	}
	return params
}
