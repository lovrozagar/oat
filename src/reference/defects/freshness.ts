/** Cached reads, under the cached-reads shape: how stale a read gets, and whether its bypass works. */
export const FRESHNESS_DEFECTS = {
	/** The cache keeps a copy past the staleness the read declares. */
	STALE_PAST_BOUND: "a cached read stays stale past the staleness bound it declares",
	/** The declared bypass header is accepted and ignored: the cache answers anyway. */
	BYPASS_IGNORED: "a read's declared cache bypass is ignored and the cache answers",
}
