/**
 * The write guard some generators publish on every written string: no NUL and no unpaired
 * surrogate, as a pattern compiled with the `u` flag. A field with a pattern of its own carries
 * both, which a document writes as an `allOf`.
 */

import type { FieldDef } from "./types.ts"

export const STRING_GUARD = "^[^\\u0000\\uD800-\\uDFFF]*$"

/** An E.164 telephone number: the pattern of its own a guarded `phone` field carries. */
export const PHONE_PATTERN = "^\\+[1-9]\\d{7,14}$"

/** `fields` with the guard after each written string's own patterns; generated fields are never written. */
export function guardStrings(fields: readonly FieldDef[]): FieldDef[] {
	return fields.map((field) =>
		field.type === "string" && field.generated !== true
			? { ...field, patterns: [...(field.patterns ?? []), STRING_GUARD] }
			: field,
	)
}
