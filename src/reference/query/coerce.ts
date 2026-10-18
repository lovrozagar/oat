import type { FieldDef } from "../model/types.ts"
import type { Scalar } from "../query-types.ts"

/**
 * The value a filter term compares against, read as the field's declared type.
 *
 * `undefined` means the text does not denote a value of that type at all. A lenient backend turns
 * that into a predicate matching nothing; a strict one rejects the request.
 */
export function coerce(raw: string, field: FieldDef): Scalar | undefined {
	if (field.type === "integer" || field.type === "number") {
		if (raw.trim() === "") return undefined
		const n = Number(raw)
		if (!Number.isFinite(n)) return undefined
		if (field.type === "integer" && !Number.isInteger(n)) return undefined
		return n
	}
	if (field.type === "boolean") {
		if (raw === "true") return true
		if (raw === "false") return false
		return undefined
	}
	return raw
}
