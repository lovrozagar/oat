/** The first defects: sessions, listings, writes, tenancy and the projections a write must reach. */
export const CORE_DEFECTS = {
	/** A destructive call, run as the second user, also kills the suite caller's session. */
	DISPOSABLE_KILLS_CALLER: "logout revokes the suite caller along with the disposable session",
	/** The caller's project read answers with no credential. */
	ROOT_READ_OPEN: "the caller project read answers with no token",
	/** Sort has no total order, so keyset paging silently drops and repeats rows. */
	UNSTABLE_SORT: "sort lacks a tiebreak; page walks drop or duplicate rows",
	/** Writes land in the item store but the list projection serves a stale snapshot. */
	STALE_LIST: "list projection does not reflect writes visible on the item route",
	/** Unrecognized filter fields are dropped instead of rejected. */
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
	 * Accepts a second create (or a colliding PATCH) of a documented unique column set.
	 *
	 * The document said these columns are unique. Returning 2xx instead of 409 is the backend
	 * ignoring that constraint — the unique-conflict checks exist to name that lie.
	 */
	UNIQUE_NOT_ENFORCED: "a duplicate unique-set write is accepted instead of 409",
	/**
	 * Accepts an Idempotency-Key and creates a second record anyway.
	 *
	 * The failure mode is a retry — a timeout, a proxy replay, a double-click — silently
	 * duplicating a charge or an order. The key is the client's only defense against that, and
	 * whether it is honored cannot be established without replaying a request.
	 */
	IDEMPOTENCY_IGNORED: "Idempotency-Key is accepted but replay creates a duplicate record",
	/**
	 * A write invalidates a route the document says it invalidates — except it does not.
	 *
	 * The parent keeps serving a derived value computed before the child write: a denormalized
	 * counter nobody refreshes, or a cached projection whose key was never busted. The write
	 * succeeds, the child's own listing is correct, and only the *other* route the document named
	 * is wrong — which is why nothing short of following `x-invalidate` finds it.
	 */
	PARENT_PROJECTION_STALE: "a route named by x-invalidate keeps serving pre-write data",
	/**
	 * The collection serves a different value for a field than the item route does.
	 *
	 * A denormalized listing, a search index rebuilt on a lag, a cached projection: each read path
	 * is internally consistent and individually plausible, so every per-projection check passes.
	 * Only comparing the paths against each other reveals that a client's view of a record depends
	 * on which route it happened to use.
	 */
	LIST_DETAIL_DISAGREE: "the collection and the item route serve different values for a field",
} as const
