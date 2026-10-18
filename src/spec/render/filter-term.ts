/** One filter predicate spelled as a term under a grammar, and what a grammar can write at all. */

import type { FilterOp } from "../../config/types/query.ts"
import { MissingValueError } from "../../errors/missing-value.ts"
import type { FilterGrammarSpec, FilterPredicate, FilterTermValue } from "./filter-types.ts"

export const PLACEHOLDER = /\{(conj|field|op|value|terms)\}/g

export function canWriteOp(spec: FilterGrammarSpec, op: FilterOp): boolean {
	if (op === "is") return spec.null !== undefined
	if (spec.ops[op] === undefined) return false
	return (op !== "in" && op !== "nin") || spec.list !== undefined
}

/** Whether terms that must all hold can share one filter value — the prerequisite for capping them. */
export function canGroupAnd(spec: FilterGrammarSpec): boolean {
	return typeof spec.and === "object" && "group" in spec.and
}

export function canWriteOr(spec: FilterGrammarSpec): boolean {
	return spec.param === "filter" && spec.or !== "none"
}

/** `template` with its placeholders filled; `null` when it holds one `pieces` lacks. */
export function fill(template: string, pieces: Partial<Record<string, string>>): string | null {
	let missing = false
	const out = template.replace(PLACEHOLDER, (whole, name: string) => {
		const piece = pieces[name]
		if (piece === undefined) missing = true
		return piece ?? whole
	})
	return missing ? null : out
}

/** One value as the grammar writes it; `null` when it carries a character the grammar cannot. */
export function scalar(spec: FilterGrammarSpec, value: string | number | boolean | null): string | null {
	/* Typed away, and still reachable from a record without the field: never write it as text. */
	if (value === undefined) throw new MissingValueError("a filter value")
	let text = value === null ? "null" : String(value)
	/* A replacement already in the value would read back as the character it stands for. */
	for (const replacement of Object.values(spec.escape)) if (text.includes(replacement)) return null
	for (const [char, replacement] of Object.entries(spec.escape)) text = text.split(char).join(replacement)
	for (const char of spec.reserved) if (text.includes(char)) return null
	return text
}

function nullToken(value: FilterTermValue): "is" | "not" | null {
	if (value === null || value === "null") return "is"
	if (value === "notnull" || value === "not.null") return "not"
	return null
}

/** The members of an `in` or `nin` value as the grammar's list; `null` when one cannot be written. */
function listValue(spec: FilterGrammarSpec, value: FilterTermValue): string | null {
	/* canWriteOp let `in` and `nin` through only for a grammar with a list. */
	const list = spec.list as NonNullable<FilterGrammarSpec["list"]>
	const members = typeof value === "object" && value !== null ? value : [value]
	/* With nothing around the list, no members reads as one empty value. */
	if (members.length === 0 && list.open === "" && list.close === "") return null
	const spelled = members.map((item) => scalar(spec, item))
	if (spelled.some((item) => item === null)) return null
	return `${list.open}${spelled.join(list.join)}${list.close}`
}

/** One predicate as the text of a term, without its parameter. */
export function renderFragment(
	spec: FilterGrammarSpec,
	predicate: FilterPredicate,
	conj: "and" | "or" = "and",
): string | null {
	const { field, op, value } = predicate
	if (!canWriteOp(spec, op)) return null
	const pieces: Record<string, string> = { field }
	const token = spec.conj?.[conj]
	if (token !== undefined) pieces.conj = token
	if (op === "is") {
		const which = nullToken(value)
		/* canWriteOp let `is` through only for a grammar with null terms. */
		const templates = spec.null as NonNullable<FilterGrammarSpec["null"]>
		return which === null ? null : fill(templates[which], pieces)
	}
	/* canWriteOp found the operator's token. */
	pieces.op = spec.ops[op] as string
	const isList = op === "in" || op === "nin"
	if (!isList && typeof value === "object" && value !== null) return null
	const spelled = isList ? listValue(spec, value) : scalar(spec, value as string | number | boolean | null)
	if (spelled === null) return null
	pieces.value = spelled
	return fill(spec.term, pieces)
}

/** One predicate as query parameters. */
export function renderTerm(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	predicate: FilterPredicate,
): Record<string, string> | null {
	const key = spec.param === "field" ? predicate.field : filterParam
	if (key === undefined) return null
	const fragment = renderFragment(spec, predicate)
	return fragment === null ? null : { [key]: fragment }
}
