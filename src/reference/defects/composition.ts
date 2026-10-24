/** Query axes that are each correct alone and break once combined, and paging cut before the filter. */
export const COMPOSITION_DEFECTS = {
	/**
	 * The filter is applied when it is the only query parameter, and dropped once a sort joins it.
	 *
	 * Models the real failure: adding an ORDER BY changes which index the planner picks, and the
	 * predicate rides on the index that is no longer chosen. Each axis is provably correct on its
	 * own, so a suite that only ever tests one at a time reports the API as clean.
	 */
	FILTER_DROPPED_WHEN_SORTED: "a filter stops being applied once a sort is also requested",
	/**
	 * The filter is applied when it is the only query parameter, and dropped once a sparse
	 * fieldset joins it.
	 *
	 * The realistic shape: a query builder that projects first and then cannot (or does not)
	 * apply a predicate to a column it just omitted — or that takes a different code path the
	 * moment `fields=` is present and forgets the WHERE. Each axis is correct alone.
	 */
	FILTER_DROPPED_WHEN_SELECTED: "a filter stops being applied once a select is also requested",
	/**
	 * The filter is applied when it is the only query parameter, and dropped once a free-text
	 * search joins it.
	 *
	 * Adding `q` often switches the backend onto a search-index path that does not honor the
	 * structured predicate. Search alone is correct, the filter alone is correct, and together
	 * the filter silently vanishes.
	 */
	FILTER_DROPPED_WHEN_SEARCHED: "a filter stops being applied once a search is also requested",
	/**
	 * The filter survives each pair — filter+sort and filter+select — and vanishes only when
	 * both extra axes are present at once.
	 *
	 * A query planner that has a two-axis path and a three-axis path, and only the latter
	 * forgets the WHERE. Every pairwise check passes; the bug is the triple.
	 */
	FILTER_DROPPED_WHEN_SORTED_AND_SELECTED:
		"a filter stops being applied once a sort and a select are requested together",
	/**
	 * The filter survives filter+search and filter+sort, and vanishes only when a search and a
	 * sort are requested together — typically the search-index path that also tries to honor
	 * an ORDER BY and drops the structured predicate to do it.
	 */
	FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED:
		"a filter stops being applied once a sort and a search are requested together",
	/**
	 * The filter survives filter+search and filter+select, and vanishes only when a search and
	 * a sparse fieldset are requested together.
	 */
	FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED:
		"a filter stops being applied once a search and a select are requested together",
	/**
	 * The page window is computed over the *unfiltered* set, and the filter is applied to whatever
	 * that window happened to contain.
	 *
	 * Page one usually looks right, which is what makes it survive review. The damage shows up
	 * further in: pages come back short, records that match the predicate are never returned at
	 * all, and the total is computed over a different set than the rows. Any code that resolves a
	 * cursor or an offset before applying the predicate has this bug.
	 */
	FILTER_AFTER_PAGINATION: "paging is applied before filtering, so pages miss matching records",
} as const
