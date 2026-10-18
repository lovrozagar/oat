import type { FilterNode, Scalar } from "../query-types.ts"
import { SqlError } from "../store-api.ts"
import type { TermRead } from "./term-types.ts"

function stripParens(value: string): string {
	return value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value
}

/** `in` and `nin`: membership in a parenthesised, comma-separated list. */
export function listTerm({ asText, ctx, field, op, raw, typed }: TermRead): FilterNode {
	const { defects, entity } = ctx
	const members = stripParens(raw)
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
	if (members.length === 0) {
		if (entity.filterCatalog?.emptyIn === "reject") throw new SqlError("invalid_filter", "empty in()")
		return { kind: "const", value: op === "nin" }
	}
	const max = entity.filterCatalog?.maxInValues
	if (max !== undefined && members.length > max && !defects.has("FILTER_IN_CAP_IGNORED")) {
		throw new SqlError("invalid_filter", `in() exceeds maxInValues=${max}`)
	}
	const values = members.map(typed).filter((value): value is Scalar => value !== undefined)
	const firstOnly =
		(defects.has("FILTER_IN_FIRST_ONLY") && op === "in") || (defects.has("FILTER_NIN_FIRST_ONLY") && op === "nin")
	const effective = firstOnly ? values.slice(0, 1) : values
	return { asText, field: field.name, kind: "in", negate: op === "nin", values: effective }
}

/** `is.null`, `is.notnull`, and `is.true` / `is.false` on a boolean. */
export function isTerm({ ctx, field, raw }: TermRead): FilterNode {
	if (raw === "null") {
		if (ctx.defects.has("FILTER_IS_NULL_MATCHES_ALL")) return { kind: "const", value: true }
		return { field: field.name, kind: "isnull", negate: false }
	}
	if (raw === "notnull" || raw === "not.null") return { field: field.name, kind: "isnull", negate: true }
	if ((raw === "true" || raw === "false") && field.type === "boolean") {
		return { asText: false, field: field.name, kind: "cmp", nullsMatch: false, op: "eq", value: raw === "true" }
	}
	throw new SqlError("invalid_filter", `is.${raw} is not a recognised predicate`)
}
