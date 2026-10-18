/** Filter terms, written in whichever grammar the endpoint speaks. */

import { canWriteOp, renderTerm } from "../render/filter-term.ts"
import { FILTER_PRESETS } from "../render/filter-presets.ts"
import type { FilterGrammarSpec, FilterPredicate, FilterQuery } from "../render/filter-types.ts"
import { renderAnd, renderOr } from "../render/filter-combine.ts"
import type { FilterOp } from "../../config/types/query.ts"
import type { QueryConventions } from "./types.ts"

/** One equality predicate: `field` equals `value`. */
export interface Equality {
	field: string
	value: string
}

/** How this endpoint's filter terms are spelled: its declared template, or its named grammar's preset. */
export function filterSpec(conventions: QueryConventions): FilterGrammarSpec {
	if (conventions.grammar === "template") {
		if (conventions.filterGrammar === undefined) throw new Error("a template grammar without its template")
		return conventions.filterGrammar
	}
	return FILTER_PRESETS[conventions.grammar]
}

/** Whether this grammar can emit `op`. */
export function canWriteFilterOp(conventions: QueryConventions, op: FilterOp): boolean {
	return canWriteOp(filterSpec(conventions), op)
}

/** Renders one filter term in whichever grammar the endpoint speaks. */
export function filterTerm(conventions: QueryConventions, predicate: FilterPredicate): Record<string, string> | null {
	return renderTerm(filterSpec(conventions), conventions.filter, predicate)
}

/** The equality term `filterTerm` wraps in its parameter, as bare text. */
export function filterFragment(conventions: QueryConventions, field: string, value: string): string | null {
	const term = filterTerm(conventions, { field, op: "eq", value })
	/* A rendered term is exactly one parameter and its text. */
	return term === null ? null : (Object.values(term)[0] as string)
}

/**
 * A conjunction of two equality predicates, in whatever grammar the endpoint speaks.
 *
 * Per-field equality ANDs implicitly — two query parameters together already mean "both must
 * hold". A raw filter expression has no such shortcut: postgrest groups with `and(...)`, the colon
 * grammar joins with a comma, and a template says which of those, or a repeated parameter, it uses.
 */
export function andTerm(conventions: QueryConventions, a: Equality, b: Equality): FilterQuery | null {
	return renderAnd(filterSpec(conventions), conventions.filter, [
		{ field: a.field, op: "eq", value: a.value },
		{ field: b.field, op: "eq", value: b.value },
	])
}

/**
 * A disjunction of two equality predicates; `null` for a grammar that has no way to ask for
 * "either" rather than "both".
 */
export function orTerm(conventions: QueryConventions, a: Equality, b: Equality): FilterQuery | null {
	return renderOr(filterSpec(conventions), conventions.filter, [
		{ field: a.field, op: "eq", value: a.value },
		{ field: b.field, op: "eq", value: b.value },
	])
}
