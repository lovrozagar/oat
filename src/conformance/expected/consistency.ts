import type { DefectName } from "../../reference/defects.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the consistency family, and the check each must trip. */
export const CONSISTENCY_EXPECTED = {
	PARENT_PROJECTION_STALE: "invalidation.declared-route-changes",
	LIST_DETAIL_DISAGREE: [
		"consistency.projections-agree",
		/* A listing serving a different value for a searchable field also breaks every predicate
		 * evaluated against the stored value: the record comes back under a name the caller can
		 * see but cannot search or filter for. */
		"search.q-narrows-result",
		"filter.equality-selects-exactly-one",
		"select.projection-honoured",
		"sort.order-is-applied",
	],
	STALE_LIST: "list.read-after-write",
	LISTED_GET_DIFFERS: "list.item-matches-listed-row",
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>
