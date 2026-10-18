import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the pagination family, and the check each must trip. */
export const PAGINATION_EXPECTED = {
	COUNT_IGNORES_FILTER: "count.matches-filtered-set",
	CURSOR_DRIFT: "pagination.cursor-agrees-with-page",
	OFF_BY_ONE_PAGE: "pagination.page-walk-covers-set",
	UNSTABLE_SORT: [
		"pagination.page-walk-covers-set",
		/* An unstable default order can hide a just-created record behind a page boundary,
		 * which the write-visibility check observes as a lost write. Same root cause. */
		"list.read-after-write",
		"sort.stable-tiebreak",
	],
	LIMIT_IGNORED: "pagination.limit-bounds-page-size",
	/* Past the maximum is also out of the declared range, which the document says is refused. */
	LIMIT_EXCEEDS_MAX: ["pagination.limit-respects-documented-max", "pagination.limit-bounds-enforced"],
	LIMIT_OUT_OF_RANGE_SERVED: "pagination.limit-bounds-enforced",
	HASMORE_ALWAYS_FALSE: "pagination.has-more-is-accurate",
	COUNT_ALWAYS_ZERO: ["count.consistent-with-returned-page", "count.matches-filtered-set"],
	COLLATION_INCONSISTENT: "pagination.cursor-agrees-with-page",
	/* A walk whose last page is full asks once more, and sees the repeat. */
	PAGE_PAST_END_REPEATS: ["pagination.bounds-handled", "pagination.page-walk-covers-set"],
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>
