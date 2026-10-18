/*
 * Null semantics, decided once and held by every store:
 *   - `eq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `ilike` never match a null value.
 *   - `neq` and `nin` do match a null value: null is not equal to, and not a member of, anything.
 *   - `is.null` / `is.notnull` test for null explicitly. `eq.null` is not a null test: on a
 *     text field it compares against the text "null", as PostgREST does.
 */

import type { DefectSet } from "../defects/defect-set.ts"
import type { FieldDef } from "../model/types.ts"
import type { ComparisonOp, FilterNode, Scalar } from "../query-types.ts"
import { SqlError } from "../store-api.ts"
import { coerce } from "./coerce.ts"
import type { QueryConventions } from "./conventions.ts"
import { isNumeric } from "./fields.ts"
import { likePattern } from "./like.ts"
import { isTerm, listTerm } from "./term-list.ts"
import type { TermInput, TermRead } from "./term-types.ts"

const BUILDERS: Readonly<Record<string, (read: TermRead) => FilterNode>> = {
	eq: eqTerm,
	gt: rangeTerm,
	gte: rangeTerm,
	ilike: likeTerm,
	in: listTerm,
	is: isTerm,
	like: likeTerm,
	lt: rangeTerm,
	lte: rangeTerm,
	neq: neqTerm,
	nin: listTerm,
}

/** One term as a predicate. Throws `SqlError` for an operator the field cannot take. */
export function buildTerm(input: TermInput): FilterNode {
	const { ctx, field, op, raw } = input
	/* An array is filtered by membership and by nothing else. */
	if (field.type === "array" || op === "contains") {
		if (field.type !== "array" || op !== "contains") {
			throw new SqlError("invalid_filter", `operator "${op}" is not supported on "${field.name}"`)
		}
		return { field: field.name, kind: "contains", substring: ctx.defects.has("CONTAINS_MATCHES_SUBSTRING"), value: raw }
	}
	const builder = Object.hasOwn(BUILDERS, op) ? BUILDERS[op] : undefined
	if (builder === undefined) throw new SqlError("invalid_filter", `unhandled operator "${op}"`)
	const asText = isNumeric(field) && ctx.defects.has("NUMERIC_COMPARED_AS_TEXT")
	return builder({ ...input, asText, typed: typedReader(field, ctx.conventions) })
}

/* A value that is not of the field's type: lenient backends match nothing, strict ones say so. */
function typedReader(field: FieldDef, conventions: QueryConventions): (text: string) => Scalar | undefined {
	return (text) => {
		const value = coerce(text, field)
		if (value === undefined && conventions.strictTypes) {
			throw new SqlError("invalid_filter", `"${text}" is not a valid ${field.type} for "${field.name}"`)
		}
		return value
	}
}

function eqTerm({ asText, ctx, field, raw, typed }: TermRead): FilterNode {
	if (ctx.defects.has("FILTER_EQ_NOT_APPLIED")) return { kind: "const", value: true }
	const value = typed(raw)
	return value === undefined
		? { kind: "const", value: false }
		: { asText, field: field.name, kind: "cmp", nullsMatch: false, op: "eq", value }
}

function neqTerm({ asText, ctx, field, raw, typed }: TermRead): FilterNode {
	const value = typed(raw)
	/* Three-valued logic leaking through: in SQL `col <> x` is NULL — not true — when col is
	 * NULL, so null rows silently vanish unless the query also tests `col IS NULL`. */
	const nullsMatch = !ctx.defects.has("NEQ_DROPS_NULLS")
	if (value === undefined) {
		/* Nothing equals a value of the wrong type, so everything — nulls included — differs. */
		return nullsMatch ? { kind: "const", value: true } : { field: field.name, kind: "isnull", negate: true }
	}
	return { asText, field: field.name, kind: "cmp", nullsMatch, op: "neq", value }
}

function rangeTerm({ asText, ctx, field, op, raw, typed }: TermRead): FilterNode {
	const value = typed(raw)
	if (value === undefined) return { kind: "const", value: false }
	const effective = effectiveRange(op as ComparisonOp, ctx.defects)
	return { asText, field: field.name, kind: "cmp", nullsMatch: false, op: effective, value }
}

/* The comparison a range operator is compiled as: a defect moves one bound across the boundary. */
function effectiveRange(op: ComparisonOp, defects: DefectSet): ComparisonOp {
	if (op === "gte" && defects.has("FILTER_GTE_IS_GT")) return "gt"
	if (op === "lte" && defects.has("FILTER_LTE_IS_LT")) return "lt"
	if (op === "lt" && defects.has("FILTER_LT_IS_LTE")) return "lte"
	return op
}

function likeTerm({ ctx, field, op, raw }: TermRead): FilterNode {
	if (field.type !== "string") throw new SqlError("invalid_filter", `${op} needs a text field`)
	return {
		field: field.name,
		insensitive: op === "ilike" && !ctx.defects.has("FILTER_ILIKE_IS_LIKE"),
		kind: "like",
		pattern: likePattern(raw, ctx.defects.has("LIKE_UNESCAPED")),
	}
}
