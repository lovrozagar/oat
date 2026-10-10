/**
 * Every registered check id. `Check.id` and `dependsOn` are typed against this list, so a
 * misspelled dependency fails to compile instead of silently never suppressing anything; the
 * registry is checked against it again when it loads.
 */
export const CHECK_IDS = [
	"async.reaches-terminal-state",
	"async.receipt-identifies-the-job",
	"auth.invite-grants-then-revokes",
	"auth.rank-is-monotonic",
	"auth.rank-is-monotonic-on-writes",
	"auth.self-is-the-caller",
	"concurrency.no-lost-update",
	"consistency.projections-agree",
	"count.consistent-with-returned-page",
	"count.matches-filtered-set",
	"create.persists-submitted-fields",
	"create.status-matches-document",
	"create.unique-conflict-rejected",
	"delete.absent-record-returns-404",
	"effects.declared-effect-occurs",
	"effects.side-effect-arrives",
	"error.malformed-filter-not-5xx",
	"filter.alias-matches-canonical",
	"filter.and-composes-as-intersection",
	"filter.condition-cap-rejected",
	"filter.contains-membership",
	"filter.empty-in",
	"filter.equality-selects-exactly-one",
	"filter.gte-is-gt-or-eq",
	"filter.ilike-is-case-insensitive",
	"filter.illegal-op-rejected",
	"filter.in-is-union-of-eq",
	"filter.in-over-limit-rejected",
	"filter.is-null-selects-nulls",
	"filter.like-metacharacters-escaped",
	"filter.lte-is-lt-or-eq",
	"filter.negation-partitions-the-set",
	"filter.nested-and-or-distributes",
	"filter.nin-complements-in",
	"filter.numeric-comparison-is-numeric",
	"filter.or-composes-as-union",
	"filter.ordered-triple-partitions",
	"filter.unknown-field-rejected",
	"filter.zero-match-returns-none",
	"idempotency.replay-does-not-duplicate",
	"invalidation.declared-route-changes",
	"list.read-after-write",
	"pagination.bounds-handled",
	"pagination.cursor-agrees-with-page",
	"pagination.has-more-is-accurate",
	"pagination.limit-bounds-page-size",
	"pagination.limit-respects-documented-max",
	"pagination.page-walk-covers-set",
	"patch.immutable-field-rejected",
	"patch.minimality",
	"payload.string-survives",
	"query.axes-compose",
	"query.filter-and-select-compose",
	"query.filter-search-select-compose",
	"query.filter-search-sort-compose",
	"query.filter-search-sort-select-compose",
	"query.filter-selects-from-whole-set",
	"query.filter-sort-select-compose",
	"query.search-and-filter-compose",
	"query.search-and-select-compose",
	"query.search-and-sort-compose",
	"query.sort-and-select-compose",
	"query.unknown-parameter-consistent",
	"response.public-get-returns-success",
	"response.status-is-documented",
	"schema.error-response-matches-document",
	"schema.success-response-matches-document",
	"search.case-insensitive",
	"search.empty-q",
	"search.mode-accepted",
	"search.q-narrows-result",
	"search.tokens-and",
	"select.nested-honoured",
	"select.projection-honoured",
	"select.requested-fields-present",
	"select.unknown-field-rejected",
	"softdelete.absent-from-default-list",
	"sort.default-order-applied",
	"sort.multi-key-tiebreak",
	"sort.nulls-first-last",
	"sort.numeric-order-is-numeric",
	"sort.order-is-applied",
	"sort.reverse-symmetry",
	"sort.stable-tiebreak",
	"sort.unknown-field-rejected",
	"spec.declared-filterable-is-filterable",
	"spec.declared-filterable-ops-accepted",
	"spec.declared-rate-limit-is-honoured",
	"spec.declared-selectable-is-selectable",
	"spec.declared-sortable-is-sortable",
	"spec.declared-sortable-nulls-accepted",
	"tenant.denial-does-not-reveal-existence",
	"tenant.filter-does-not-bypass-scope",
	"tenant.item-not-readable-cross-tenant",
	"tenant.parent-not-reachable-from-another-root",
	"tenant.item-not-writable-cross-tenant",
	"update.unique-conflict-rejected",
	"validation.content-type-enforced",
	"validation.enum-enforced",
	"validation.max-length-enforced",
	"validation.required-enforced",
] as const

export type CheckId = (typeof CHECK_IDS)[number]

/** The families checks are grouped, built and verified by. */
export type CheckFamily =
	| "pagination"
	| "filter"
	| "sort"
	| "search/select"
	| "composition"
	| "write"
	| "validation"
	| "isolation"
	| "effects/async"
	| "conformance"
	| "spec declarations"
	| "consistency"

type Prefix<Id> = Id extends `${infer Head}.${string}` ? Head : never

/** Every check id prefix belongs to exactly one family; a new prefix fails to compile until it has one. */
export const FAMILY_OF_PREFIX: Record<Prefix<CheckId>, CheckFamily> = {
	async: "effects/async",
	auth: "isolation",
	concurrency: "write",
	consistency: "consistency",
	count: "pagination",
	create: "write",
	delete: "write",
	effects: "effects/async",
	error: "filter",
	filter: "filter",
	idempotency: "write",
	invalidation: "consistency",
	list: "consistency",
	pagination: "pagination",
	patch: "write",
	payload: "write",
	query: "composition",
	response: "conformance",
	schema: "conformance",
	search: "search/select",
	select: "search/select",
	softdelete: "write",
	sort: "sort",
	spec: "spec declarations",
	tenant: "isolation",
	update: "write",
	validation: "validation",
}

export function familyOf(id: CheckId): CheckFamily {
	return FAMILY_OF_PREFIX[id.slice(0, id.indexOf(".")) as Prefix<CheckId>]
}
