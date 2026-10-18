import type { DefectName } from "../../reference/defects.ts"

/** The defects whose primary check is in the filter family, and the check each must trip. */
export const FILTER_EXPECTED = {
	FILTER_GROUP_COMBINATOR_SWAPPED: [
		"filter.and-composes-as-intersection",
		/* Only fires where an or() combinator exists to swap at all — the postgrest-shaped
		 * dialects. On the others the swap still corrupts and(), which is the primary. */
		"filter.or-composes-as-union",
	],
	ERROR_500_ON_BAD_FILTER: [
		"error.malformed-filter-not-5xx",
		/* A crash on an unknown field is this check's own failure: it is not rejected. */
		"filter.unknown-field-rejected",
		/* 500 is not in the document. The status-vs-document check is a real second symptom,
		 * not a misdiagnosis: the handler crashed and invented a code the spec never named. */
		"response.status-is-documented",
		/* Every crash a filter probe draws that no filter check cited is failed on its own. */
		"response.no-server-error",
	],
	FILTER_IGNORED: "filter.unknown-field-rejected",
	LIKE_UNESCAPED: "filter.like-metacharacters-escaped",
	FILTER_EQ_NOT_APPLIED: [
		"filter.equality-selects-exactly-one",
		"filter.zero-match-returns-none",
		"filter.negation-partitions-the-set",
		"count.matches-filtered-set",
		"filter.like-metacharacters-escaped",
	],
	EMPTY_RESULT_RETURNS_ALL: [
		"filter.zero-match-returns-none",
		"filter.unknown-field-rejected",
		"filter.like-metacharacters-escaped",
		/* Falling back to the unfiltered set breaks every narrowing predicate, not just the
		 * filter that triggered it — search and the tenant-scoped filter included. */
		"search.q-narrows-result",
		"tenant.filter-does-not-bypass-scope",
		"filter.negation-partitions-the-set",
		/* A page walk narrows too: the final page's query legitimately matches nothing, and a
		 * backend that answers "nothing" with "everything" makes records reappear mid-walk. */
		"pagination.page-walk-covers-set",
		"count.matches-filtered-set",
		"filter.empty-in",
	],
	NEQ_DROPS_NULLS: "filter.negation-partitions-the-set",
	NUMERIC_COMPARED_AS_TEXT: [
		"filter.numeric-comparison-is-numeric",
		"sort.order-is-applied",
		"sort.reverse-symmetry",
		"sort.numeric-order-is-numeric",
		"pagination.page-walk-covers-set",
		"pagination.cursor-agrees-with-page",
	],
	FILTER_IN_FIRST_ONLY: "filter.in-is-union-of-eq",
	FILTER_GTE_IS_GT: "filter.gte-is-gt-or-eq",
	FILTER_ILIKE_IS_LIKE: "filter.ilike-is-case-insensitive",
	FILTER_IS_NULL_MATCHES_ALL: "filter.is-null-selects-nulls",
	FILTER_ILLEGAL_OP_IGNORED: "filter.illegal-op-rejected",
	IGNORES_MALFORMED_FILTER: "filter.malformed-term-rejected",
	FILTER_ALIAS_MISMAPPED: [
		"filter.alias-matches-canonical",
		/* `ne` read as `eq` is legal on a field that allows eq and not neq — so an operator the
		 * document closes off is accepted. The same mismapping, seen from the allowlist. */
		"filter.illegal-op-rejected",
	],
	FILTER_CONDITION_CAP_IGNORED: "filter.condition-cap-rejected",
	FILTER_IN_CAP_IGNORED: "filter.in-over-limit-rejected",
	FILTER_LTE_IS_LT: "filter.lte-is-lt-or-eq",
	FILTER_LT_IS_LTE: "filter.ordered-triple-partitions",
	FILTER_NESTED_COMBINATOR_LEAKS: "filter.nested-and-or-distributes",
	FILTER_NIN_FIRST_ONLY: "filter.nin-complements-in",
	CONTAINS_MATCHES_SUBSTRING: "filter.contains-membership",
} satisfies Partial<Record<DefectName, string | string[]>>
