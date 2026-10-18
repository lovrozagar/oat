/**
 * The conventions a reference backend speaks.
 *
 * Everything oat had quietly hardcoded — what the page-size parameter is called, where the total
 * lives in the envelope, how a filter expression is spelled — varies wildly between real APIs
 * and not at all between two instances of the same fixture. A single-dialect fixture therefore
 * proves that the checks work on *one* shape, which is a much weaker claim than it appears.
 *
 * Two dialects, differing in every name and in the filter grammar, turn that into a real test:
 * the defects and the checks are identical, so anything that passes on one and fails on the
 * other was reading a convention rather than the contract.
 */

import type { Dialect } from "./types.ts"

/** `field.op.value` with cursor pagination and entity-named collections. */
export const POSTGREST: Dialect = {
	envelope: {
		collection: null,
		hasMore: "hasMore",
		limit: "limit",
		nextCursor: "nextCursor",
		page: "page",
		total: "count",
	},
	grammar: "postgrest",
	name: "postgrest",
	params: {
		cursor: "cursor",
		filter: "filter",
		limit: "limit",
		order: "order",
		page: "page",
		search: "q",
		searchMode: "search_mode",
		select: "select",
	},
}

/**
 * A deliberately unrelated spelling: `per_page`, `sort`, `fields`, `search`, a `data` envelope
 * with `total_count`/`has_more`, no cursor at all, and `field=op:value` filters.
 *
 * Nothing here shares a name with the other dialect, so a check that still works is working from
 * the document rather than from familiarity.
 */
export const CLASSIC: Dialect = {
	envelope: {
		collection: "data",
		hasMore: "has_more",
		limit: "per_page",
		page: "page",
		total: "total_count",
	},
	grammar: "colon",
	name: "classic",
	params: {
		filter: "filter",
		limit: "per_page",
		order: "sort",
		page: "page",
		search: "search",
		select: "fields",
	},
}

/**
 * Root array, `Link` header pagination, `offset`/`limit`.
 *
 * No envelope at all: the body is the array, there is no total, no `hasMore`, and no page number.
 * Whether more pages exist is answered by `rel="next"` in a header. Nothing about a check should
 * have to change for this, and where something does, the check was reading the fixture's habits.
 */
export const LINKED: Dialect = {
	envelope: null,
	grammar: "postgrest",
	name: "linked",
	params: {
		filter: "filter",
		limit: "limit",
		offset: "offset",
		order: "order",
		search: "q",
		select: "fields",
	},
}

/**
 * JSON:API-flavoured: `sort=-name` for descending, `fields[table]=id,name` for projection.
 *
 * The parameter *names* here are unremarkable — `sort`, `fields`, `page`, `filter` — which is the
 * point. Everything oat had generalised was the name; the value grammars stayed hardcoded to one
 * spelling. A shape that renames nothing but writes its values differently is the sharpest test
 * of whether that generalisation was real.
 */
export const JSONAPI: Dialect = {
	envelope: {
		collection: "data",
		hasMore: "has_more",
		limit: "size",
		page: "number",
		total: "total",
	},
	grammar: "postgrest",
	name: "jsonapi",
	params: {
		filter: "filter",
		limit: "size",
		order: "sort",
		page: "page",
		search: "q",
		select: "fields",
	},
	selectGrammar: "bracketed",
	sortGrammar: "prefixed",
}

/**
 * The plainest shape there is: `?status=active&page=2`, no filter expression language at all.
 *
 * Half of oat's query checks cannot be expressed here — there is no way to write a negation, a
 * range, or a pattern — and that is precisely the point. Every one of them must report what it
 * could not test and why, because a run that goes quiet against the most common API shape in the
 * world is the single most damaging way this tool could fail.
 */
export const PLAIN: Dialect = {
	envelope: {
		collection: "items",
		hasMore: "has_more",
		limit: "limit",
		page: "page",
		total: "total",
	},
	grammar: "equality",
	name: "plain",
	params: {
		/* Declared for completeness; the equality grammar never sends it, and the fixture never
		 * reads it. A parameter a backend accepts and ignores is itself a defect oat reports. */
		filter: "filter",
		limit: "limit",
		order: "sort",
		page: "page",
		search: "q",
		select: "fields",
	},
	sortGrammar: "colon",
}

/**
 * A grammar oat has no name for, declared as a template: one term per filter parameter,
 * `and_status_eq_active`, repeated for every term. `ne` spells not-equal, null tests are terms of
 * their own, `in` values are comma-joined, an underscore in a value is written `~`, and `like`
 * matches a bare substring. Sort keys are `name_ascending` / `name_descending`, comma-joined.
 *
 * Nothing in oat may know this grammar except through the declaration, so every filter check that
 * still runs here is reading the template rather than a preset.
 */
export const TEMPLATE: Dialect = {
	envelope: {
		collection: "results",
		hasMore: "has_more",
		limit: "limit",
		page: "page",
		total: "total",
	},
	filterTemplate: {
		combine: "repeat",
		conj: { and: "and", or: "or" },
		escape: { _: "~" },
		likeMatches: "contains",
		list: ",",
		null: { is: "{conj}_{field}_is_null", not: "{conj}_{field}_isn_null" },
		ops: { eq: "eq", gt: "gt", gte: "gte", in: "in", like: "like", lt: "lt", lte: "lte", neq: "ne" },
		or: "terms",
		term: "{conj}_{field}_{op}_{value}",
	},
	grammar: "template",
	name: "template",
	sortGrammar: "template",
	sortTemplate: { asc: "ascending", desc: "descending", join: ",", term: "{field}_{direction}" },
	params: {
		filter: "where",
		limit: "limit",
		order: "sort",
		page: "page",
		search: "search",
		select: "fields",
	},
}

export const DIALECTS: Record<string, Dialect> = {
	jsonapi: JSONAPI,
	plain: PLAIN,
	classic: CLASSIC,
	linked: LINKED,
	postgrest: POSTGREST,
	template: TEMPLATE,
}
