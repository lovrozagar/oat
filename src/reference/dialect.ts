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

export interface Dialect {
	name: string
	/** Query parameter names, by role. */
	params: {
		filter: string
		order: string
		select: string
		search: string
		limit: string
		/** Page number, where the API counts pages. Absent when it counts rows skipped. */
		page?: string
		/** Rows to skip, where the API pages by offset rather than page number. */
		offset?: string
		cursor?: string
	}
	/**
	 * Envelope property names, by role.
	 *
	 * `null` for the whole object means the response *is* the array and pagination facts travel in
	 * a `Link` header instead — the GitHub shape. That is a different pagination model, not a
	 * different spelling of one, which is precisely why it belongs in the fixture: a tool that
	 * only ever saw facts in a body may be reading conventions rather than the contract.
	 */
	envelope: {
		/** Property holding the array. `null` means "named after the entity" — `tables`, `rows`. */
		collection: string | null
		total: string
		hasMore: string
		nextCursor?: string
		page: string
		limit: string
	} | null
	/**
	 * How filter expressions are written.
	 *
	 * `equality` has no filter parameter at all: each filterable field is its own query parameter,
	 * and only equality is expressible. It is the most common shape in the wild and the one where
	 * oat can say the least — which makes it the real test of whether "I cannot express this" is
	 * reported honestly rather than silently skipped.
	 */
	grammar: "postgrest" | "colon" | "equality"
	/** How sort directions are written. Defaults to the dotted form when unset. */
	sortGrammar?: "dotted" | "prefixed" | "colon" | "spaced"
	/** How a sparse fieldset is written. Defaults to comma-separated names. */
	selectGrammar?: "csv" | "bracketed"
}

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

export const DIALECTS: Record<string, Dialect> = {
	jsonapi: JSONAPI,
	plain: PLAIN,
	classic: CLASSIC,
	linked: LINKED,
	postgrest: POSTGREST,
}

/**
 * Rewrites a filter expression from a dialect's grammar into the canonical `field.op.value` the
 * stores parse, so the storage layer never has to know which dialect it is serving.
 *
 * Returns `null` when the expression is malformed, which the caller surfaces as a 400 — the same
 * treatment the canonical grammar gets.
 */
export function toCanonicalFilter(expression: string, dialect: Dialect): string | null {
	/* Already canonical: the postgrest grammar *is* the canonical form, and the equality grammar
	 * has no expression of its own — the per-field parameters were assembled into canonical terms
	 * before reaching here. Re-parsing that would reject a well-formed expression. */
	if (dialect.grammar === "postgrest" || dialect.grammar === "equality") return expression

	/* `status=eq:active`, joined by commas. No grouping: the point of a second dialect is
	 * different spelling, not a second expression language to maintain. */
	const terms = expression
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean)
	if (terms.length === 0) return null

	const canonical: string[] = []
	for (const term of terms) {
		const match = /^([^=]+)=([a-z]+):(.*)$/s.exec(term)
		if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null
		canonical.push(`${match[1]}.${match[2]}.${match[3]}`)
	}
	return canonical.length === 1 ? (canonical[0] as string) : `and(${canonical.join(",")})`
}
