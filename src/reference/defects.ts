/**
 * Defects the reference backend can be told to exhibit.
 *
 * Each one is a real bug seen in production APIs, reduced to its smallest form. The conformance
 * suite switches them on individually and asserts oat reports exactly that defect and nothing
 * else — which is what turns "oat is smart" into precision and recall numbers.
 *
 * Keep the implementations naive and obvious. If the reference backend grows clever it starts
 * encoding the same assumptions oat does, and the two drift together into agreeing on nonsense.
 */

export const DEFECTS = {
	/** Sort has no total order, so keyset paging silently drops and repeats rows. */
	UNSTABLE_SORT: "sort lacks a tiebreak; page walks drop or duplicate rows",
	/** Writes land in the item store but the list projection serves a stale snapshot. */
	STALE_LIST: "list projection does not reflect writes visible on the item route",
	/** Unrecognised filter fields are dropped instead of rejected. */
	FILTER_IGNORED: "unknown filter field is silently ignored rather than rejected",
	/** Cursor pagination and offset pagination disagree about the underlying set. */
	CURSOR_DRIFT: "cursor pagination yields a different set than offset pagination",
	/** PATCH behaves as PUT, clearing fields the caller never mentioned. */
	PATCH_REPLACES: "PATCH clears fields absent from the request body",
	/** Total count ignores the active filter. */
	COUNT_IGNORES_FILTER: "count reflects the unfiltered set",
	/** The tenant predicate is applied to the list query but not to filter matches. */
	TENANT_LEAK_VIA_FILTER: "filter bypasses the tenant predicate",
	/**
	 * Denies cross-tenant reads with 403 rather than 404.
	 *
	 * The access decision is correct — the record is not served — but the status distinguishes
	 * "exists, not yours" from "does not exist", which turns the item route into an oracle for
	 * enumerating other tenants' identifiers.
	 */
	EXISTENCE_LEAK_VIA_STATUS: "cross-tenant denial uses 403, revealing that the record exists",
	/**
	 * Accepts an Idempotency-Key and creates a second record anyway.
	 *
	 * The failure mode is a retry — a timeout, a proxy replay, a double-click — silently
	 * duplicating a charge or an order. The key is the client's only defence against that, and
	 * whether it is honoured cannot be established without replaying a request.
	 */
	IDEMPOTENCY_IGNORED: "Idempotency-Key is accepted but replay creates a duplicate record",
	/**
	 * A write invalidates a route the document says it invalidates — except it does not.
	 *
	 * The parent keeps serving a derived value computed before the child write: a denormalised
	 * counter nobody refreshes, or a cached projection whose key was never busted. The write
	 * succeeds, the child's own listing is correct, and only the *other* route the document named
	 * is wrong — which is why nothing short of following `x-invalidate` finds it.
	 */
	PARENT_PROJECTION_STALE: "a route named by x-invalidate keeps serving pre-write data",
	/**
	 * The collection serves a different value for a field than the item route does.
	 *
	 * A denormalised listing, a search index rebuilt on a lag, a cached projection: each read path
	 * is internally consistent and individually plausible, so every per-projection check passes.
	 * Only comparing the paths against each other reveals that a client's view of a record depends
	 * on which route it happened to use.
	 */
	LIST_DETAIL_DISAGREE: "the collection and the item route serve different values for a field",
	/**
	 * The filter is applied when it is the only query parameter, and dropped once a sort joins it.
	 *
	 * Models the real failure: adding an ORDER BY changes which index the planner picks, and the
	 * predicate rides on the index that is no longer chosen. Each axis is provably correct on its
	 * own, so a suite that only ever tests one at a time reports the API as clean.
	 */
	FILTER_DROPPED_WHEN_SORTED: "a filter stops being applied once a sort is also requested",
	/**
	 * The filter is applied when it is the only query parameter, and dropped once a sparse
	 * fieldset joins it.
	 *
	 * The realistic shape: a query builder that projects first and then cannot (or does not)
	 * apply a predicate to a column it just omitted — or that takes a different code path the
	 * moment `fields=` is present and forgets the WHERE. Each axis is correct alone.
	 */
	FILTER_DROPPED_WHEN_SELECTED: "a filter stops being applied once a select is also requested",
	/**
	 * The filter is applied when it is the only query parameter, and dropped once a free-text
	 * search joins it.
	 *
	 * Adding `q` often switches the backend onto a search-index path that does not honour the
	 * structured predicate. Search alone is correct, the filter alone is correct, and together
	 * the filter silently vanishes.
	 */
	FILTER_DROPPED_WHEN_SEARCHED: "a filter stops being applied once a search is also requested",
	/**
	 * The filter survives each pair — filter+sort and filter+select — and vanishes only when
	 * both extra axes are present at once.
	 *
	 * A query planner that has a two-axis path and a three-axis path, and only the latter
	 * forgets the WHERE. Every pairwise check passes; the bug is the triple.
	 */
	FILTER_DROPPED_WHEN_SORTED_AND_SELECTED:
		"a filter stops being applied once a sort and a select are requested together",
	/**
	 * The filter survives filter+search and filter+sort, and vanishes only when a search and a
	 * sort are requested together — typically the search-index path that also tries to honour
	 * an ORDER BY and drops the structured predicate to do it.
	 */
	FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED:
		"a filter stops being applied once a sort and a search are requested together",
	/**
	 * The filter survives filter+search and filter+select, and vanishes only when a search and
	 * a sparse fieldset are requested together.
	 */
	FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED:
		"a filter stops being applied once a search and a select are requested together",
	/**
	 * The page window is computed over the *unfiltered* set, and the filter is applied to whatever
	 * that window happened to contain.
	 *
	 * Page one usually looks right, which is what makes it survive review. The damage shows up
	 * further in: pages come back short, records that match the predicate are never returned at
	 * all, and the total is computed over a different set than the rows. Any code that resolves a
	 * cursor or an offset before applying the predicate has this bug.
	 */
	FILTER_AFTER_PAGINATION: "paging is applied before filtering, so pages miss matching records",
	/**
	 * The document declares a field filterable that the backend rejects.
	 *
	 * Not a backend bug — the backend is entitled to refuse a field it never indexed. The document
	 * is what is wrong, and it is wrong in the most expensive way: every client generated from it
	 * offers a filter that 400s at runtime. oat is the only thing positioned to notice, because it
	 * is the only thing that reads the claim and then tries it.
	 */
	SPEC_OVERCLAIMS_FILTERABLE: "x-query declares a field filterable that the backend rejects",
	/**
	 * The document declares a field sortable that the backend rejects.
	 *
	 * Same failure as SPEC_OVERCLAIMS_FILTERABLE, one role over: the backend is entitled to refuse
	 * a field it never indexed for ordering, but the document is wrong to promise it can. Every
	 * client generated from this document offers an `order` value that 400s at runtime.
	 */
	SPEC_OVERCLAIMS_SORTABLE: "x-query declares a field sortable that the backend rejects",
	/**
	 * `and(a,b)` and `or(a,b)` are compiled with their joiner swapped: a conjunction evaluates as
	 * a disjunction and vice versa.
	 *
	 * A realistic shape for the bug: a query builder that always joins terms with the same
	 * operator regardless of which combinator the expression named, because the grouping was
	 * parsed but never actually consulted when assembling the join. Every single-predicate filter
	 * check still passes — the defect is invisible until two terms are combined.
	 */
	FILTER_GROUP_COMBINATOR_SWAPPED: "and() and or() combinators inside a filter expression are swapped",
	/**
	 * The document declares a field selectable that the backend rejects.
	 *
	 * The select analogue of SPEC_OVERCLAIMS_FILTERABLE and SPEC_OVERCLAIMS_SORTABLE: the backend
	 * is entitled to stop projecting a column, but the document is wrong to keep promising it can.
	 */
	SPEC_OVERCLAIMS_SELECTABLE: "x-query declares a field selectable that the backend rejects",
	/** Tombstoned records remain in the default listing. */
	SOFT_DELETE_LEAK: "soft-deleted records still appear in the default list",
	/** Server-owned fields accept client writes. */
	IMMUTABLE_WRITABLE: "immutable field accepts a write",
	/** Sparse fieldsets are accepted and ignored. */
	SELECT_IGNORED: "select returns every field regardless of what was requested",
	/** LIKE metacharacters in user input are not escaped. */
	LIKE_UNESCAPED: "unescaped LIKE metacharacters make a filter match everything",
	/** Offset arithmetic is wrong by one row per page. */
	OFF_BY_ONE_PAGE: "page offset is computed one row late",
	/** Create returns a status the document does not declare. */
	CREATED_201_AS_200: "create returns 200 where the document declares 201",
	/** Malformed input crashes instead of being rejected. */
	ERROR_500_ON_BAD_FILTER: "malformed filter produces 500 instead of 400",
	/** Deleting an absent record reports success. */
	DELETE_MISSING_OK: "deleting a nonexistent record returns success instead of 404",
	/** Reads of another tenant's record succeed. */
	CROSS_TENANT_READ: "item route serves records belonging to another tenant",
	/** The page-size parameter is accepted and ignored. */
	LIMIT_IGNORED: "limit is accepted but does not bound the page size",
	/** More rows are returned than the documented maximum allows. */
	LIMIT_EXCEEDS_MAX: "page size exceeds the documented maxLimit",
	/** The more-pages flag is always false, so callers stop after page one. */
	HASMORE_ALWAYS_FALSE: "hasMore is false even when further pages exist",
	/** The sort parameter is accepted and ignored. */
	ORDER_IGNORED: "order is accepted but does not change the result order",
	/** The search parameter is accepted and ignored. */
	SEARCH_IGNORED: "q is accepted but does not filter the result",
	/** A field is accepted at create and silently discarded. */
	CREATE_DROPS_FIELD: "create accepts a field and does not persist it",
	/** An enum field accepts values outside the declared set. */
	ENUM_NOT_VALIDATED: "enum field accepts a value outside the declared set",
	/** A string longer than maxLength is stored. */
	MAXLENGTH_NOT_VALIDATED: "string exceeding maxLength is accepted",
	/** A create missing a required field succeeds. */
	REQUIRED_NOT_VALIDATED: "create succeeds with a required field missing",
	/** A non-JSON content type is accepted on a JSON endpoint. */
	CONTENT_TYPE_NOT_ENFORCED: "request body is parsed regardless of content type",
	/** Error bodies do not match the documented error schema. */
	ERROR_SCHEMA_DRIFT: "error response does not match its documented schema",
	/** Success bodies carry fields the schema does not declare. */
	RESPONSE_SCHEMA_DRIFT: "success response carries undeclared fields",
	/** An equality predicate is parsed and then never applied. */
	FILTER_EQ_NOT_APPLIED: "eq predicate is accepted but matches every record",
	/** An empty filtered set is replaced by the unfiltered one. */
	EMPTY_RESULT_RETURNS_ALL: "a filter matching nothing falls back to returning everything",
	/** SQL three-valued logic leaking through: NULL rows vanish from a negated predicate. */
	NEQ_DROPS_NULLS: "neq silently excludes records whose value is null",
	/** The total is computed by a query that disagrees with the one producing the rows. */
	COUNT_ALWAYS_ZERO: "count reports zero while the same body returns records",
	/** Descending order drops the rows an ascending order includes. */
	SORT_DESC_DROPS_NULLS: "descending sort omits records with a null sort key",
	/** An operation declares an effect in the document and does not perform it. */
	EFFECT_NOT_APPLIED: "declared x-effects side effect never happens",
	/** An async job never leaves its running state. */
	ASYNC_NEVER_COMPLETES: "async job stays pending forever and never reaches a terminal state",
	/** The receipt for an async job omits the identifier needed to poll it. */
	ASYNC_RECEIPT_MISSING_ID: "async receipt omits the job id the document declares",
	/**
	 * DDL names a physical column differently from every read.
	 *
	 * SQL-store only, and modelled on a real production bug: SQLite resolves an unknown
	 * double-quoted identifier as a *string literal* instead of erroring, so the mismatch
	 * surfaces as every row reporting the column's own name as its value — silent corruption
	 * rather than a loud failure.
	 */
	COLUMN_NAME_MISMATCH: "physical column name differs from the name every read uses",
	/**
	 * Numeric columns compared as text, so `amount > 9` misses 10 and ordering reads
	 * 1, 10, 100, 2. Extremely common wherever query values arrive untyped from a URL.
	 */
	NUMERIC_COMPARED_AS_TEXT: "numeric column is compared and ordered as text",
	/**
	 * The listing and the cursor lookup disagree about collation, so keyset pagination resolves
	 * a boundary the listing never had — rows are skipped or repeated between pages.
	 */
	COLLATION_INCONSISTENT: "cursor resolution uses a different collation than the listing",
	/**
	 * Read-modify-write without locking: the handler reads the row, then writes every column
	 * back. Two concurrent patches to different fields, and the later write reinstates the
	 * earlier field's old value — the classic ORM `save(entity)` lost update.
	 */
	CONCURRENT_WRITE_LOST: "concurrent writes to different fields lose one of them",
	/**
	 * A lower-ranked role can read a record that a higher-ranked role in the same tenant cannot.
	 *
	 * The lattice is inverted on the item route only: a viewer is served, a member is denied,
	 * the owner still reads. Isolation and the write path stay intact; the failure is purely
	 * that privilege is not monotonic.
	 */
	ROLE_MONOTONICITY_BROKEN: "a lower-ranked role can read a record a higher-ranked same-tenant role cannot",
	/** Accept completes but the invitee still cannot read the shared record. */
	INVITE_NEVER_GRANTS: "accepting an invite does not grant access to the record",
	/** Revoke returns success and the invitee can still read. */
	REVOKE_IGNORED: "revoking an invite does not remove access",
} as const

export type DefectName = keyof typeof DEFECTS

export class DefectSet {
	private readonly enabled: ReadonlySet<string>

	constructor(names: readonly string[] = []) {
		this.enabled = new Set(names)
	}

	static fromEnv(value: string | undefined): DefectSet {
		if (value === undefined || value.trim() === "") return new DefectSet()
		return new DefectSet(
			value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		)
	}

	has(name: DefectName): boolean {
		return this.enabled.has(name)
	}

	list(): DefectName[] {
		return [...this.enabled] as DefectName[]
	}
}

export function isDefectName(value: string): value is DefectName {
	return Object.hasOwn(DEFECTS, value)
}
