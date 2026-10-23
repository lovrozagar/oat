/** A field's query type read off its schema, for a declared field that does not state one. */

import type { FieldType } from "../../config/types/query.ts"
import { scalarKinds } from "../schema.ts"
import type { JsonSchema } from "../types.ts"

export function inferFieldType(schema: JsonSchema | undefined): FieldType | undefined {
	if (schema === undefined) return undefined
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum"
	const format = typeof schema.format === "string" ? schema.format : ""
	if (format === "date" || format === "date-time") return "date"
	if (schema.type === "array") return "array"
	const kinds = scalarKinds(schema)
	if (kinds === undefined) return undefined
	/* An integer filters as a number; a field that admits two kinds has no one type to filter as. */
	const types = new Set(kinds.map((kind) => (kind === "integer" ? "number" : kind)))
	return types.size === 1 ? ([...types][0] as FieldType) : undefined
}

export function inferTypesFromSchema(schema: JsonSchema | null | undefined): Map<string, FieldType> {
	const out = new Map<string, FieldType>()
	const props = schema?.properties
	if (props === null || props === undefined || typeof props !== "object") return out
	for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
		if (raw === null || typeof raw !== "object") continue
		const type = inferFieldType(raw as JsonSchema)
		if (type !== undefined) out.set(name, type)
	}
	return out
}
