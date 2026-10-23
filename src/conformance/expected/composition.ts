import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects with a row in the composition family; a name that is not a defect falls out and fails its row. */
type CompositionDefect = Extract<
	DefectName,
	| "FILTER_AFTER_PAGINATION"
	| "FILTER_DROPPED_WHEN_SORTED"
	| "FILTER_DROPPED_WHEN_SELECTED"
	| "FILTER_DROPPED_WHEN_SEARCHED"
	| "FILTER_DROPPED_WHEN_SORTED_AND_SELECTED"
	| "FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED"
	| "FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED"
	| "FILTER_DROPPED_WHEN_SORTED_SEARCHED_AND_SELECTED"
	| "SEARCH_DROPPED_WHEN_SELECTED"
	| "SEARCH_DROPPED_WHEN_SORTED"
	| "ORDER_DROPPED_WHEN_SELECTED"
	| "UNKNOWN_PARAM_EMPTIES_LIST"
>

/** The defects whose primary check is in the composition family, and the check each must trip. */
export const COMPOSITION_EXPECTED: Record<CompositionDefect, FindingId | FindingId[]> = {
	FILTER_AFTER_PAGINATION: [
		"query.filter-selects-from-whole-set",
		/* The same misordering makes a filtered page shorter than the page size, which the
		 * count and negation properties observe from their own angles. */
		"count.matches-filtered-set",
		"filter.negation-partitions-the-set",
		"filter.equality-selects-exactly-one",
		"filter.zero-match-returns-none",
		"query.axes-compose",
		/* A range predicate is evaluated over the same truncated window, so it under-matches too. */
		"filter.numeric-comparison-is-numeric",
		/* And a record that falls outside the window is absent from a filtered projection while
		 * present in the item route, which is a genuine disagreement between read paths. */
		"consistency.projections-agree",
		/* The tenant-scoping probe filters too, so its records fall outside the window and the
		 * leak it looks for cannot be observed. */
		"tenant.filter-does-not-bypass-scope",
		/* A membership filter is a filter: its matches outside the window are lost the same way. */
		"filter.contains-membership",
	],
	FILTER_DROPPED_WHEN_SORTED: [
		"query.axes-compose",
		/* A sorted page walk gathers its set with the filter present, so the same drop shows up
		 * there — and the negation check partitions across pages under a sort too. */
		"filter.negation-partitions-the-set",
		"pagination.page-walk-covers-set",
		"count.matches-filtered-set",
		/* Every larger composition that sorts a filter sees the same drop. */
		"query.filter-search-sort-compose",
		"query.filter-sort-select-compose",
		"query.filter-search-sort-select-compose",
	],
	/* As above: each composition holding the filter and the axis that drops it sees the drop. */
	FILTER_DROPPED_WHEN_SELECTED: [
		"query.filter-and-select-compose",
		"query.filter-search-select-compose",
		"query.filter-sort-select-compose",
		"query.filter-search-sort-select-compose",
	],
	FILTER_DROPPED_WHEN_SEARCHED: [
		"query.search-and-filter-compose",
		"query.filter-search-sort-compose",
		"query.filter-search-select-compose",
		"query.filter-search-sort-select-compose",
	],
	/* The four-axis query holds each of these pairs, so it sees the dropped filter too — and
	 * reports it whenever another defect leaves the triple unable to. */
	FILTER_DROPPED_WHEN_SORTED_AND_SELECTED: [
		"query.filter-sort-select-compose",
		"query.filter-search-sort-select-compose",
	],
	FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED: [
		"query.filter-search-sort-compose",
		"query.filter-search-sort-select-compose",
	],
	FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED: [
		"query.filter-search-select-compose",
		"query.filter-search-sort-select-compose",
	],
	FILTER_DROPPED_WHEN_SORTED_SEARCHED_AND_SELECTED: "query.filter-search-sort-select-compose",
	/* The search is dropped wherever a select joins it, the filter+search+select triple included. */
	SEARCH_DROPPED_WHEN_SELECTED: [
		"query.search-and-select-compose",
		"query.filter-search-select-compose",
		"query.filter-search-sort-select-compose",
	],
	SEARCH_DROPPED_WHEN_SORTED: [
		"query.search-and-sort-compose",
		"query.filter-search-sort-compose",
		"query.filter-search-sort-select-compose",
	],
	ORDER_DROPPED_WHEN_SELECTED: [
		"query.sort-and-select-compose",
		"query.filter-sort-select-compose",
		"query.filter-search-sort-select-compose",
	],
	UNKNOWN_PARAM_EMPTIES_LIST: "query.unknown-parameter-consistent",
}
