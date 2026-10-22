/** Form fields as the key/value pairs a urlencoded body sends. */

import { unencodedPairs } from "../../client/param-style.ts"
import type { FieldEncoding } from "./types.ts"

/**
 * One form field as the key/value pairs the operation's `encoding` says it becomes.
 *
 * The OpenAPI default for a form is `style: form, explode: true`: an array repeats its key per
 * item, an object spreads its properties as keys of their own. `deepObject` writes `name[key]`;
 * `explode: false` joins with the style's delimiter; a JSON `contentType` sends the value as JSON.
 * The parameter serializer writes them; the body's encoder encodes them.
 */
export function formPairs(name: string, value: unknown, encoding: FieldEncoding | undefined): Array<[string, string]> {
	if (value === undefined || value === null) return []
	if (encoding?.contentType?.includes("json") === true) return [[name, JSON.stringify(value)]]
	return unencodedPairs({ ...encoding, name }, value)
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
