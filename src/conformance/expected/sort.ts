import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the sort family, and the check each must trip. */
export const SORT_EXPECTED = {
	ORDER_IGNORED: "sort.order-is-applied",
	SORT_DESC_DROPS_NULLS: "sort.reverse-symmetry",
	IGNORES_BAD_SORT_DIRECTION: "sort.invalid-direction-rejected",
	SORT_NUMERIC_AS_TEXT: "sort.numeric-order-is-numeric",
	SORT_MULTI_KEY_IGNORED: "sort.multi-key-tiebreak",
	SORT_NULLS_MODIFIER_IGNORED: "sort.nulls-first-last",
	SORT_UNKNOWN_FIELD_IGNORED: "sort.unknown-field-rejected",
	DEFAULT_ORDER_IGNORED: "sort.default-order-applied",
	TIEBREAK_NOT_APPLIED: "sort.stable-tiebreak",
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>
