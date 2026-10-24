import { contractCallCheck } from "../contract/check.ts"
import { disposableCheck } from "../disposable/check.ts"
import { publicGetCheck } from "../one-shot.ts"
import { rootReadCheck } from "../root-read.ts"
import { selfIdentityCheck } from "../self/check.ts"
import { serverErrorCheck } from "../server-errors.ts"
import type { RegisteredCheck } from "./core/check.ts"
import { queryAxesCompose } from "./families/composition/query-axes-compose.ts"
import { filterAndSelectCompose } from "./families/composition/query-filter-and-select-compose.ts"
import { filterSearchSelectCompose } from "./families/composition/query-filter-search-select-compose.ts"
import { filterSearchSortCompose } from "./families/composition/query-filter-search-sort-compose.ts"
import { queryFilterSearchSortSelectCompose } from "./families/composition/query-filter-search-sort-select-compose.ts"
import { filterAndPagingCompose } from "./families/composition/query-filter-selects-from-whole-set.ts"
import { filterSortSelectCompose } from "./families/composition/query-filter-sort-select-compose.ts"
import { searchAndFilterCompose } from "./families/composition/query-search-and-filter-compose.ts"
import { querySearchAndSelectCompose } from "./families/composition/query-search-and-select-compose.ts"
import { querySearchAndSortCompose } from "./families/composition/query-search-and-sort-compose.ts"
import { querySortAndSelectCompose } from "./families/composition/query-sort-and-select-compose.ts"
import { unknownParameterConsistent } from "./families/composition/query-unknown-parameter-consistent.ts"
import { documentedStatusHonoured } from "./families/conformance/response-status-is-documented.ts"
import { errorSchemaHonoured } from "./families/conformance/schema-error-response-matches-document.ts"
import { problemJsonShape } from "./families/conformance/schema-problem-json-shape.ts"
import { readSchemaHonoured } from "./families/conformance/schema-read-response-matches-document.ts"
import { writeOnlyNotReturned } from "./families/conformance/response-write-only-not-returned.ts"
import { successSchemaHonoured } from "./families/conformance/schema-success-response-matches-document.ts"
import { projectionsAgree } from "./families/consistency/consistency-projections-agree.ts"
import { declaredInvalidationHappens } from "./families/consistency/invalidation-declared-route-changes.ts"
import { listedRowIsTheGet } from "./families/consistency/list-item-matches-listed-row.ts"
import { readAfterWrite } from "./families/consistency/list-read-after-write.ts"
import { asyncReachesTerminalState } from "./families/effects-async/async-reaches-terminal-state.ts"
import { asyncReceiptIsResolvable } from "./families/effects-async/async-receipt-identifies-the-job.ts"
import { declaredEffectsOccur } from "./families/effects-async/effects-declared-effect-occurs.ts"
import { sideEffectArrives } from "./families/effects-async/effects-side-effect-arrives.ts"
import { malformedFilterNot5xx } from "./families/filter/error-malformed-filter-not-5xx.ts"
import { filterAliasMatchesCanonical } from "./families/filter/filter-alias-matches-canonical.ts"
import { filterAndComposesAsIntersection } from "./families/filter/filter-and-composes-as-intersection.ts"
import { filterConditionCapRejected } from "./families/filter/filter-condition-cap-rejected.ts"
import { filterContainsMembership } from "./families/filter/filter-contains-membership.ts"
import { filterEmptyIn } from "./families/filter/filter-empty-in.ts"
import { equalityFilterSelectsOne } from "./families/filter/filter-equality-selects-exactly-one.ts"
import { filterGteIsGtOrEq } from "./families/filter/filter-gte-is-gt-or-eq.ts"
import { filterIlikeIsCaseInsensitive } from "./families/filter/filter-ilike-is-case-insensitive.ts"
import { filterIllegalOpRejected } from "./families/filter/filter-illegal-op-rejected.ts"
import { filterInIsUnionOfEq } from "./families/filter/filter-in-is-union-of-eq.ts"
import { filterInOverLimitRejected } from "./families/filter/filter-in-over-limit-rejected.ts"
import { filterIsNullSelectsNulls } from "./families/filter/filter-is-null-selects-nulls.ts"
import { likeEscaping } from "./families/filter/filter-like-metacharacters-escaped.ts"
import { filterLteIsLtOrEq } from "./families/filter/filter-lte-is-lt-or-eq.ts"
import { filterMalformedTermRejected } from "./families/filter/filter-malformed-term-rejected.ts"
import { negationPartitions } from "./families/filter/filter-negation-partitions-the-set.ts"
import { filterNestedAndOrDistributes } from "./families/filter/filter-nested-and-or-distributes.ts"
import { filterNinComplementsIn } from "./families/filter/filter-nin-complements-in.ts"
import { numericComparisonIsNumeric } from "./families/filter/filter-numeric-comparison-is-numeric.ts"
import { filterOrComposesAsUnion } from "./families/filter/filter-or-composes-as-union.ts"
import { filterOrderedTriplePartitions } from "./families/filter/filter-ordered-triple-partitions.ts"
import { unknownFilterRejected } from "./families/filter/filter-unknown-field-rejected.ts"
import { zeroMatchFilter } from "./families/filter/filter-zero-match-returns-none.ts"
import { alternativeAccepted } from "./families/security/auth-alternative-accepted.ts"
import { anonymousOperationOpen } from "./families/security/auth-anonymous-operation-open.ts"
import { crossTenantKeyRefused } from "./families/security/auth-cross-tenant-key-refused.ts"
import { invalidCredentialRefused } from "./families/security/auth-invalid-credential-refused.ts"
import { loginThrottled } from "./families/security/auth-login-throttled.ts"
import { missingCredentialRefused } from "./families/security/auth-missing-credential-refused.ts"
import { privilegedFieldIgnored } from "./families/security/auth-privileged-field-ignored.ts"
import { refreshReuseRefused } from "./families/security/auth-refresh-reuse-refused.ts"
import { revokedCredentialRefused } from "./families/security/auth-revoked-credential-refused.ts"
import { roleEnforced } from "./families/security/auth-role-enforced.ts"
import { scopeEnforced } from "./families/security/auth-scope-enforced.ts"
import { wrongSchemeRefused } from "./families/security/auth-wrong-scheme-refused.ts"
import { inviteGrantsThenRevokes } from "./families/isolation/auth-invite-grants-then-revokes.ts"
import { rankIsMonotonicOnWrites } from "./families/isolation/auth-rank-is-monotonic-on-writes.ts"
import { rankIsMonotonic } from "./families/isolation/auth-rank-is-monotonic.ts"
import { denialDoesNotRevealExistence } from "./families/isolation/tenant-denial-does-not-reveal-existence.ts"
import { crossTenantFilterBypass } from "./families/isolation/tenant-filter-does-not-bypass-scope.ts"
import { crossTenantItemRead } from "./families/isolation/tenant-item-not-readable-cross-tenant.ts"
import { crossTenantItemWrite } from "./families/isolation/tenant-item-not-writable-cross-tenant.ts"
import { foreignParentRejected } from "./families/isolation/tenant-parent-not-reachable-from-another-root.ts"
import { countIsConsistentWithPage } from "./families/pagination/count-consistent-with-returned-page.ts"
import { countMatchesWalk } from "./families/pagination/count-matches-filtered-set.ts"
import { paginationBoundsHandled } from "./families/pagination/pagination-bounds-handled.ts"
import { cursorAgreesWithPage } from "./families/pagination/pagination-cursor-agrees-with-page.ts"
import { hasMoreIsAccurate } from "./families/pagination/pagination-has-more-is-accurate.ts"
import { limitBoundsEnforced } from "./families/pagination/pagination-limit-bounds-enforced.ts"
import { limitBoundsPageSize } from "./families/pagination/pagination-limit-bounds-page-size.ts"
import { limitRespectsMax } from "./families/pagination/pagination-limit-respects-documented-max.ts"
import { pageWalkCoversSet } from "./families/pagination/pagination-page-walk-covers-set.ts"
import { searchCaseInsensitive } from "./families/search-select/search-case-insensitive.ts"
import { searchEmptyQ } from "./families/search-select/search-empty-q.ts"
import { searchModeAccepted } from "./families/search-select/search-mode-accepted.ts"
import { searchNarrowsResult } from "./families/search-select/search-q-narrows-result.ts"
import { searchTokensAnd } from "./families/search-select/search-tokens-and.ts"
import { selectNestedHonoured } from "./families/search-select/select-nested-honoured.ts"
import { selectProjection } from "./families/search-select/select-projection-honoured.ts"
import { selectRequestedFieldsPresent } from "./families/search-select/select-requested-fields-present.ts"
import { selectUnknownFieldRejected } from "./families/search-select/select-unknown-field-rejected.ts"
import { sortDefaultOrderApplied } from "./families/sort/sort-default-order-applied.ts"
import { sortInvalidDirectionRejected } from "./families/sort/sort-invalid-direction-rejected.ts"
import { sortMultiKeyTiebreak } from "./families/sort/sort-multi-key-tiebreak.ts"
import { sortNullsFirstLast } from "./families/sort/sort-nulls-first-last.ts"
import { sortNumericOrderIsNumeric } from "./families/sort/sort-numeric-order-is-numeric.ts"
import { orderChangesResult } from "./families/sort/sort-order-is-applied.ts"
import { sortReverseSymmetry } from "./families/sort/sort-reverse-symmetry.ts"
import { sortStableTiebreak } from "./families/sort/sort-stable-tiebreak.ts"
import { sortUnknownFieldRejected } from "./families/sort/sort-unknown-field-rejected.ts"
import { declaredFilterableWorks } from "./families/spec-declarations/spec-declared-filterable-is-filterable.ts"
import { declaredFilterableOpsAccepted } from "./families/spec-declarations/spec-declared-filterable-ops-accepted.ts"
import { declaredRateLimitHonoured } from "./families/spec-declarations/spec-declared-rate-limit-is-honoured.ts"
import { declaredSelectableWorks } from "./families/spec-declarations/spec-declared-selectable-is-selectable.ts"
import { declaredSortableWorks } from "./families/spec-declarations/spec-declared-sortable-is-sortable.ts"
import { declaredSortableNullsAccepted } from "./families/spec-declarations/spec-declared-sortable-nulls-accepted.ts"
import { invalidBodyRefused } from "./families/validation/request-invalid-body-refused.ts"
import { contentTypeEnforced } from "./families/validation/validation-content-type-enforced.ts"
import { enumValidated } from "./families/validation/validation-enum-enforced.ts"
import { maxLengthValidated } from "./families/validation/validation-max-length-enforced.ts"
import { requiredValidated } from "./families/validation/validation-required-enforced.ts"
import { ifMatchEnforced } from "./families/write/concurrency-if-match-enforced.ts"
import { noLostUpdate } from "./families/write/concurrency-no-lost-update.ts"
import { createKeepsSubmittedIdentity } from "./families/write/create-keeps-submitted-identity.ts"
import { createPersistsFields } from "./families/write/create-persists-submitted-fields.ts"
import { createStatusMatchesSpec } from "./families/write/create-status-matches-document.ts"
import { uniqueConflictCreate } from "./families/write/create-unique-conflict-rejected.ts"
import { deleteMissingIs404 } from "./families/write/delete-absent-record-returns-404.ts"
import { idempotentReplay } from "./families/write/idempotency-replay-does-not-duplicate.ts"
import { immutableRejected } from "./families/write/patch-immutable-field-rejected.ts"
import { patchMinimality } from "./families/write/patch-minimality.ts"
import { stringPayloadSurvives } from "./families/write/payload-string-survives.ts"
import { softDeleteHidden } from "./families/write/softdelete-absent-from-default-list.ts"
import { uniqueConflictUpdate } from "./families/write/update-unique-conflict-rejected.ts"

export const CHECKS: readonly RegisteredCheck[] = [
	/* foundations — did the write land, is it visible, and do the paging primitives work at all.
	 * Everything below assumes these hold, so they must be evaluated first for cascade
	 * suppression to have anything to consult. */
	createKeepsSubmittedIdentity,
	readAfterWrite,
	listedRowIsTheGet,
	createPersistsFields,
	createStatusMatchesSpec,
	successSchemaHonoured,
	limitBoundsPageSize,
	limitRespectsMax,
	hasMoreIsAccurate,
	/* Ordering and the page walk are foundations too, not query niceties: the set-algebra checks
	 * below gather their sets *across pages*, so a broken walk would corrupt the very sets they
	 * compare. Establishing paging first is what lets those failures be suppressed as cascades
	 * rather than re-reported once per predicate. */
	orderChangesResult,
	pageWalkCoversSet,
	cursorAgreesWithPage,
	/* Where the filter is applied relative to paging: every filtered read below relies on it. */
	filterAndPagingCompose,
	paginationBoundsHandled,
	sortNumericOrderIsNumeric,
	sortStableTiebreak,
	/* These read whole sets in both directions, so they come after the walk they rely on. */
	sortReverseSymmetry,
	sortNullsFirstLast,
	sortMultiKeyTiebreak,
	sortDefaultOrderApplied,

	/* query semantics */
	unknownFilterRejected,
	malformedFilterNot5xx,
	sortUnknownFieldRejected,
	sortInvalidDirectionRejected,
	equalityFilterSelectsOne,
	zeroMatchFilter,
	negationPartitions,
	filterAndComposesAsIntersection,
	filterOrComposesAsUnion,
	filterInIsUnionOfEq,
	filterNinComplementsIn,
	filterNestedAndOrDistributes,
	likeEscaping,
	filterIlikeIsCaseInsensitive,
	filterIsNullSelectsNulls,
	filterContainsMembership,
	searchNarrowsResult,
	searchTokensAnd,
	searchCaseInsensitive,
	searchEmptyQ,
	searchModeAccepted,
	selectProjection,
	selectRequestedFieldsPresent,
	selectUnknownFieldRejected,
	unknownParameterConsistent,
	selectNestedHonoured,
	countIsConsistentWithPage,
	countMatchesWalk,
	numericComparisonIsNumeric,
	filterGteIsGtOrEq,
	filterLteIsLtOrEq,
	filterOrderedTriplePartitions,

	/* write semantics */
	uniqueConflictCreate,
	uniqueConflictUpdate,
	patchMinimality,
	immutableRejected,
	stringPayloadSurvives,
	idempotentReplay,
	declaredInvalidationHappens,
	projectionsAgree,
	queryAxesCompose,
	filterAndSelectCompose,
	searchAndFilterCompose,
	filterSortSelectCompose,
	filterSearchSortCompose,
	filterSearchSelectCompose,
	querySortAndSelectCompose,
	querySearchAndSelectCompose,
	querySearchAndSortCompose,
	queryFilterSearchSortSelectCompose,
	declaredFilterableWorks,
	declaredFilterableOpsAccepted,
	declaredSortableWorks,
	declaredSortableNullsAccepted,
	declaredSelectableWorks,
	filterAliasMatchesCanonical,
	filterIllegalOpRejected,
	limitBoundsEnforced,
	filterMalformedTermRejected,
	filterEmptyIn,
	filterInOverLimitRejected,
	filterConditionCapRejected,
	noLostUpdate,
	deleteMissingIs404,
	softDeleteHidden,

	/* input validation */
	enumValidated,
	maxLengthValidated,
	requiredValidated,
	contentTypeEnforced,

	/* security: planned per operation by the security stage, not by the entity lanes */
	missingCredentialRefused,
	invalidCredentialRefused,
	wrongSchemeRefused,
	scopeEnforced,
	alternativeAccepted,
	anonymousOperationOpen,
	revokedCredentialRefused,
	refreshReuseRefused,
	roleEnforced,
	crossTenantKeyRefused,
	privilegedFieldIgnored,
	loginThrottled,
	/* input validation of every other write, planned per operation by the same stage, after the
	 * security probes so none of theirs moves */
	invalidBodyRefused,

	/* isolation */
	crossTenantItemRead,
	crossTenantItemWrite,
	foreignParentRejected,
	denialDoesNotRevealExistence,
	crossTenantFilterBypass,
	rankIsMonotonic,
	rankIsMonotonicOnWrites,
	inviteGrantsThenRevokes,
	selfIdentityCheck,
	rootReadCheck,
	disposableCheck,
	publicGetCheck,
	contractCallCheck,
	serverErrorCheck,

	/* declared side effects and async lifecycles, last: both invoke operations that change the
	 * world, and both are meaningless if the read surface above is already known broken */
	declaredEffectsOccur,
	sideEffectArrives,
	asyncReachesTerminalState,
	asyncReceiptIsResolvable,
	/* The last writer, right before the judges, so they see its 412. Only the judges come after it,
	 * and they draw no salt, so registering it moved no other check's bodies. */
	ifMatchEnforced,
	/* After every other check has written to the transcript — create is owned by
	 * create.status-matches-document. */
	documentedStatusHonoured,
	errorSchemaHonoured,
	readSchemaHonoured,
	writeOnlyNotReturned,
	problemJsonShape,
	declaredRateLimitHonoured,
]
