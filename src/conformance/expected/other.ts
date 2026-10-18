import type { DefectName } from "../../reference/defects.ts"

/** The defects whose primary check is in the other family, and the check each must trip. */
export const OTHER_EXPECTED = {
	SPEC_OVERCLAIMS_FILTERABLE: "spec.declared-filterable-is-filterable",
	SPEC_OVERCLAIMS_SORTABLE: ["spec.declared-sortable-is-sortable", "spec.declared-sortable-nulls-accepted"],
	SPEC_OVERCLAIMS_SELECTABLE: "spec.declared-selectable-is-selectable",
	SELECT_IGNORED: "select.projection-honoured",
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
	NESTED_SELECT_IGNORED: "select.nested-honoured",
	SIDE_EFFECT_NEVER_ARRIVES: "effects.side-effect-arrives",
	RATE_LIMIT_STRICTER_THAN_DECLARED: "spec.declared-rate-limit-is-honoured",
} satisfies Partial<Record<DefectName, string | string[]>>
