import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects with a row in the consistency family; a name that is not a defect falls out and fails its row. */
type ConsistencyDefect = Extract<
	DefectName,
	| "PARENT_PROJECTION_STALE"
	| "LIST_DETAIL_DISAGREE"
	| "STALE_LIST"
	| "LISTED_GET_DIFFERS"
	| "STALE_PAST_BOUND"
	| "BYPASS_IGNORED"
>

/** The defects whose primary check is in the consistency family, and the check each must trip. */
export const CONSISTENCY_EXPECTED: Record<ConsistencyDefect, FindingId | FindingId[]> = {
	PARENT_PROJECTION_STALE: "invalidation.declared-route-changes",
	LIST_DETAIL_DISAGREE: [
		"consistency.projections-agree",
		/* A listing serving a different value for a searchable field also breaks every predicate
		 * evaluated against the stored value: the record comes back under a name the caller can
		 * see but cannot search or filter for. */
		"search.q-narrows-result",
		"filter.equality-selects-exactly-one",
		"select.projection-honored",
		"sort.order-is-applied",
		/* The listing's suffix carries a name at its maxLength past it: a value its schema forbids. */
		"schema.read-response-matches-document",
	],
	STALE_LIST: "list.read-after-write",
	LISTED_GET_DIFFERS: "list.item-matches-listed-row",
	STALE_PAST_BOUND: "consistency.staleness-within-bound",
	BYPASS_IGNORED: "consistency.bypass-is-fresh",
}
