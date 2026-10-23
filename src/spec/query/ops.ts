/**
 * The tokens a query capability is spelled in: the filter operators, field types and nulls
 * placements oat knows, and the guards that tell a declared token from junk.
 */

import type { FieldType, FilterOp, Nulls } from "../../config/types/query.ts"

export const FILTER_OPS: readonly FilterOp[] = [
	"eq",
	"ne",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"nin",
	"like",
	"ilike",
	"is",
	"contains",
]

export const FIELD_TYPES: readonly FieldType[] = ["string", "number", "boolean", "date", "enum", "array"]

/** Ops oat already wrote in 0.7.0. Implicit only when nothing declared a closed list. */
export const IMPLICIT_OPS: readonly FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "like"]
export const ORDERED_TYPES: ReadonlySet<FieldType> = /* @__PURE__ */ new Set(["number", "date"])

export function isFilterOp(value: string): value is FilterOp {
	return (FILTER_OPS as readonly string[]).includes(value)
}

export function isFieldType(value: string): value is FieldType {
	return (FIELD_TYPES as readonly string[]).includes(value)
}

export function isNulls(value: string): value is Nulls {
	return value === "first" || value === "last"
}
