import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects with a row in the other family; a name that is not a defect falls out and fails its row. */
type OtherDefect = Extract<
	DefectName,
	| "SPEC_OVERCLAIMS_FILTERABLE"
	| "SPEC_OVERCLAIMS_SORTABLE"
	| "SPEC_OVERCLAIMS_SELECTABLE"
	| "SELECT_IGNORED"
	| "SEARCH_IGNORED"
	| "EFFECT_NOT_APPLIED"
	| "SELECT_FIELD_MISSING"
	| "ASYNC_NEVER_COMPLETES"
	| "ASYNC_RECEIPT_MISSING_ID"
	| "SEARCH_CASE_SENSITIVE"
	| "SEARCH_EMPTY_MATCHES_NONE"
	| "SEARCH_ONLY_FIRST_TOKEN"
	| "SELECT_UNKNOWN_IGNORED"
	| "SPEC_OVERCLAIMS_FILTER_OP"
	| "SEARCH_MODE_REJECTED"
	| "NESTED_SELECT_IGNORED"
	| "SIDE_EFFECT_NEVER_ARRIVES"
	| "RATE_LIMIT_STRICTER_THAN_DECLARED"
>

/** The defects whose primary check is in the other family, and the check each must trip. */
export const OTHER_EXPECTED: Record<OtherDefect, FindingId | FindingId[]> = {
	SPEC_OVERCLAIMS_FILTERABLE: "spec.declared-filterable-is-filterable",
	SPEC_OVERCLAIMS_SORTABLE: ["spec.declared-sortable-is-sortable", "spec.declared-sortable-nulls-accepted"],
	SPEC_OVERCLAIMS_SELECTABLE: "spec.declared-selectable-is-selectable",
	SELECT_IGNORED: "select.projection-honored",
	SEARCH_IGNORED: "search.q-narrows-result",
	EFFECT_NOT_APPLIED: ["effects.declared-effect-occurs", "async.reaches-terminal-state"],
	SELECT_FIELD_MISSING: "select.requested-fields-present",
	ASYNC_NEVER_COMPLETES: "async.reaches-terminal-state",
	ASYNC_RECEIPT_MISSING_ID: [
		"async.receipt-identifies-the-job",
		"async.reaches-terminal-state",
		"schema.success-response-matches-document",
	],
	SEARCH_CASE_SENSITIVE: "search.case-insensitive",
	SEARCH_EMPTY_MATCHES_NONE: "search.empty-q",
	SEARCH_ONLY_FIRST_TOKEN: "search.tokens-and",
	SELECT_UNKNOWN_IGNORED: "select.unknown-field-rejected",
	SPEC_OVERCLAIMS_FILTER_OP: "spec.declared-filterable-ops-accepted",
	SEARCH_MODE_REJECTED: "search.mode-accepted",
	NESTED_SELECT_IGNORED: "select.nested-honored",
	SIDE_EFFECT_NEVER_ARRIVES: "effects.side-effect-arrives",
	RATE_LIMIT_STRICTER_THAN_DECLARED: "spec.declared-rate-limit-is-honored",
}
