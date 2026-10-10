/**
 * Typical requests per check per entity, measured on the reference backend across its dialects —
 * what `oat plan` estimates a run's cost from before a request is sent. Regenerate after a
 * check's request pattern changes; a check missing here is estimated at `DEFAULT_CHECK_COST`.
 */
import type { EntityModel, SpecModel } from "../spec/graph.ts"
import type { CheckId } from "./check-ids.ts"
import { CHECKS } from "./checks.ts"

export const TYPICAL_REQUESTS: Partial<Record<CheckId, number>> = {
	"async.reaches-terminal-state": 5,
	"async.receipt-identifies-the-job": 1,
	"auth.invite-grants-then-revokes": 7,
	"auth.rank-is-monotonic": 3,
	"auth.self-is-the-caller": 4,
	"concurrency.no-lost-update": 5,
	"consistency.projections-agree": 6,
	"count.consistent-with-returned-page": 1,
	"count.matches-filtered-set": 1,
	"create.persists-submitted-fields": 1,
	"create.status-matches-document": 1,
	"create.unique-conflict-rejected": 3,
	"delete.absent-record-returns-404": 1,
	"effects.declared-effect-occurs": 3,
	"effects.side-effect-arrives": 3,
	"error.malformed-filter-not-5xx": 1,
	"filter.alias-matches-canonical": 1,
	"filter.and-composes-as-intersection": 4,
	"filter.condition-cap-rejected": 1,
	"filter.contains-membership": 1,
	"filter.empty-in": 2,
	"filter.equality-selects-exactly-one": 1,
	"filter.gte-is-gt-or-eq": 4,
	"filter.ilike-is-case-insensitive": 2,
	"filter.illegal-op-rejected": 2,
	"filter.in-is-union-of-eq": 3,
	"filter.in-over-limit-rejected": 1,
	"filter.is-null-selects-nulls": 2,
	"filter.like-metacharacters-escaped": 2,
	"filter.lte-is-lt-or-eq": 3,
	"filter.negation-partitions-the-set": 3,
	"filter.nested-and-or-distributes": 4,
	"filter.nin-complements-in": 2,
	"filter.numeric-comparison-is-numeric": 1,
	"filter.or-composes-as-union": 2,
	"filter.ordered-triple-partitions": 6,
	"filter.unknown-field-rejected": 2,
	"filter.zero-match-returns-none": 1,
	"idempotency.replay-does-not-duplicate": 7,
	"invalidation.declared-route-changes": 5,
	"list.read-after-write": 2,
	"pagination.cursor-agrees-with-page": 10,
	"pagination.has-more-is-accurate": 2,
	"pagination.limit-bounds-page-size": 1,
	"pagination.limit-respects-documented-max": 1,
	"pagination.page-walk-covers-set": 13,
	"patch.immutable-field-rejected": 2,
	"patch.minimality": 6,
	"payload.string-survives": 128,
	"query.axes-compose": 5,
	"query.filter-and-select-compose": 4,
	"query.filter-search-select-compose": 1,
	"query.filter-search-sort-compose": 1,
	"query.filter-search-sort-select-compose": 1,
	"query.filter-selects-from-whole-set": 21,
	"query.filter-sort-select-compose": 4,
	"query.search-and-filter-compose": 2,
	"query.search-and-select-compose": 4,
	"query.search-and-sort-compose": 2,
	"query.sort-and-select-compose": 1,
	"response.public-get-returns-success": 1,
	"response.status-is-documented": 1,
	"schema.error-response-matches-document": 1,
	"schema.success-response-matches-document": 1,
	"search.case-insensitive": 1,
	"search.empty-q": 4,
	"search.mode-accepted": 2,
	"search.q-narrows-result": 2,
	"search.tokens-and": 3,
	"select.nested-honoured": 1,
	"select.projection-honoured": 1,
	"select.requested-fields-present": 1,
	"select.unknown-field-rejected": 1,
	"softdelete.absent-from-default-list": 3,
	"sort.default-order-applied": 3,
	"sort.multi-key-tiebreak": 2,
	"sort.nulls-first-last": 2,
	"sort.numeric-order-is-numeric": 1,
	"sort.order-is-applied": 1,
	"sort.reverse-symmetry": 4,
	"sort.stable-tiebreak": 4,
	"sort.unknown-field-rejected": 1,
	"spec.declared-filterable-is-filterable": 9,
	"spec.declared-filterable-ops-accepted": 41,
	"spec.declared-rate-limit-is-honoured": 1,
	"spec.declared-selectable-is-selectable": 10,
	"spec.declared-sortable-is-sortable": 8,
	"spec.declared-sortable-nulls-accepted": 20,
	"tenant.denial-does-not-reveal-existence": 2,
	"tenant.filter-does-not-bypass-scope": 1,
	"tenant.item-not-readable-cross-tenant": 1,
	"update.unique-conflict-rejected": 5,
	"validation.content-type-enforced": 1,
	"validation.enum-enforced": 1,
	"validation.max-length-enforced": 1,
	"validation.required-enforced": 1,
}

const DEFAULT_CHECK_COST = 2

/**
 * Estimated requests for testing one entity: seeding the cohort, then every check that would
 * grade one of its operations. Static, like the plan it belongs to — the real count depends on
 * what the backend answers.
 */
export function estimateRequests(entity: EntityModel, model: SpecModel, cohortSize = 7): number {
	const seeding = entity.create === undefined ? 1 : cohortSize + 1
	let checks = 0
	for (const check of CHECKS) {
		if (check.subjects(entity, model).length === 0) continue
		checks += TYPICAL_REQUESTS[check.id] ?? DEFAULT_CHECK_COST
	}
	return seeding + checks
}
