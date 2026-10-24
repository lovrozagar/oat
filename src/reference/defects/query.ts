/** What a filter, a sort or a sparse fieldset means: operators, keys, projections, and fields the document overclaims. */
export const QUERY_DEFECTS = {
	/**
	 * The document declares a field filterable that the backend rejects.
	 *
	 * Not a backend bug — the backend is entitled to refuse a field it never indexed. The document
	 * is what is wrong, and it is wrong in the most expensive way: every client generated from it
	 * offers a filter that 400s at runtime. oat is the only thing positioned to notice, because it
	 * is the only thing that reads the claim and then tries it.
	 */
	SPEC_OVERCLAIMS_FILTERABLE: "x-query declares a field filterable that the backend rejects",
	/** `in.(a,b)` only honors the first member. */
	FILTER_IN_FIRST_ONLY: "in() matches only the first listed value",
	/** `gte` is compiled as `gt`. */
	FILTER_GTE_IS_GT: "gte is implemented as gt",
	/** `ilike` is compiled as case-sensitive `like`. */
	FILTER_ILIKE_IS_LIKE: "ilike is implemented as like",
	/** `is.null` matches every row. */
	FILTER_IS_NULL_MATCHES_ALL: "is.null matches every row",
	/** An operator outside the field's allowlist is ignored (200 + full set). */
	FILTER_ILLEGAL_OP_IGNORED: "an illegal filter operator is accepted and ignored",
	/** A filter term the grammar cannot parse is dropped (200 + full set) instead of refused. */
	IGNORES_MALFORMED_FILTER: "a malformed filter term is dropped instead of refused",
	/** A sort direction the grammar does not have is read as ascending instead of refused. */
	IGNORES_BAD_SORT_DIRECTION: "an unknown sort direction sorts ascending instead of being refused",
	/** Numeric sort compares as text. */
	SORT_NUMERIC_AS_TEXT: "a numeric sortable field is ordered lexicographically",
	/** Only the first order key is honored. */
	SORT_MULTI_KEY_IGNORED: "the second sort key is ignored",
	/** A requested select field is omitted from the projection. */
	SELECT_FIELD_MISSING: "a requested select field is dropped from the projection",
	/**
	 * The document declares a field sortable that the backend rejects.
	 *
	 * Same failure as SPEC_OVERCLAIMS_FILTERABLE, one role over: the backend is entitled to refuse
	 * a field it never indexed for ordering, but the document is wrong to promise it can. Every
	 * client generated from this document offers an `order` value that 400s at runtime.
	 */
	SPEC_OVERCLAIMS_SORTABLE: "x-query declares a field sortable that the backend rejects",
	/**
	 * `and(a,b)` and `or(a,b)` are compiled with their joiner swapped: a conjunction evaluates as
	 * a disjunction and vice versa.
	 *
	 * A realistic shape for the bug: a query builder that always joins terms with the same
	 * operator regardless of which combinator the expression named, because the grouping was
	 * parsed but never actually consulted when assembling the join. Every single-predicate filter
	 * check still passes — the defect is invisible until two terms are combined.
	 */
	FILTER_GROUP_COMBINATOR_SWAPPED: "and() and or() combinators inside a filter expression are swapped",
	/**
	 * The document declares a field selectable that the backend rejects.
	 *
	 * The select analog of SPEC_OVERCLAIMS_FILTERABLE and SPEC_OVERCLAIMS_SORTABLE: the backend
	 * is entitled to stop projecting a column, but the document is wrong to keep promising it can.
	 */
	SPEC_OVERCLAIMS_SELECTABLE: "x-query declares a field selectable that the backend rejects",
} as const
