/**
 * The security family: per-operation checks of what a request's credentials must and must not get
 * it. An explicit set rather than a prefix, so the `auth.rank-*` and `auth.invite-*` checks stay in
 * isolation. A security check's id is added here alone: `CHECK_IDS` takes it from this list.
 */
export const SECURITY_CHECK_IDS = [
	"auth.missing-credential-refused",
	"auth.invalid-credential-refused",
	"auth.wrong-scheme-refused",
	"auth.scope-enforced",
	"auth.alternative-accepted",
	"auth.anonymous-operation-open",
	"auth.revoked-credential-refused",
	"auth.refresh-reuse-refused",
	"auth.role-enforced",
	"auth.cross-tenant-key-refused",
	"auth.privileged-field-ignored",
	"auth.login-throttled",
] as const

/** Every check id outside the security set: each takes its family from its prefix (`FAMILY_OF_PREFIX`). */
const PREFIXED_CHECK_IDS = [
	"async.reaches-terminal-state",
	"async.receipt-identifies-the-job",
	"auth.invite-grants-then-revokes",
	"auth.rank-is-monotonic",
	"auth.rank-is-monotonic-on-writes",
	"auth.destructive-spares-the-caller",
	"auth.self-is-the-caller",
	"concurrency.if-match-enforced",
	"concurrency.no-lost-update",
	"consistency.projections-agree",
	"count.consistent-with-returned-page",
	"count.matches-filtered-set",
	"create.persists-submitted-fields",
	"create.keeps-submitted-identity",
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
	"pagination.limit-bounds-enforced",
	"filter.malformed-term-rejected",
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
	"list.item-matches-listed-row",
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
	"read.matches-caller-root",
	"request.invalid-body-refused",
	"response.contract-call",
	"response.no-server-error",
	"response.public-get-returns-success",
	"response.status-is-documented",
	"response.write-only-not-returned",
	"schema.error-response-matches-document",
	"schema.problem-json-shape",
	"schema.read-response-matches-document",
	"schema.success-response-matches-document",
	"search.case-insensitive",
	"search.empty-q",
	"search.mode-accepted",
	"search.q-narrows-result",
	"search.tokens-and",
	"select.nested-honored",
	"select.projection-honored",
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
	"sort.invalid-direction-rejected",
	"spec.declared-filterable-is-filterable",
	"spec.declared-filterable-ops-accepted",
	"spec.declared-rate-limit-is-honored",
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

/**
 * Every registered check id. `Check.id` and `dependsOn` are typed against this list, so a
 * misspelled dependency fails to compile instead of silently never suppressing anything; the
 * registry is checked against it again when it loads.
 */
export const CHECK_IDS: readonly [...typeof SECURITY_CHECK_IDS, ...typeof PREFIXED_CHECK_IDS] = [
	...SECURITY_CHECK_IDS,
	...PREFIXED_CHECK_IDS,
]

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
	| "security"

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
	read: "isolation",
	request: "validation",
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

/**
 * Findings the run raises itself, outside any registered check: a seed or teardown that failed,
 * a principal or a credential BLOCKED because a login, signup or refresh failed, the network or
 * the run stopping. Reports name them and
 * conformance expects them like any check, so they are typed the same way: a misspelled one fails
 * to compile.
 */
export const RUN_FINDING_IDS = [
	"auth.blocked",
	"create.does-not-error",
	"net.unreachable",
	"profile.skip",
	"run.error",
	"run.interrupted",
	"teardown.verify-hook",
	"world.seed",
	"world.teardown",
] as const

export type RunFindingId = (typeof RUN_FINDING_IDS)[number]

/** What a finding names: the check that raised it, or the run itself. */
export type FindingId = CheckId | RunFindingId

/** The family of `id`: `security` when the security set names it, else its prefix's family. */
export function familyOf(id: CheckId, security: readonly string[] = SECURITY_CHECK_IDS): CheckFamily {
	return security.includes(id) ? "security" : FAMILY_OF_PREFIX[id.slice(0, id.indexOf(".")) as Prefix<CheckId>]
}
