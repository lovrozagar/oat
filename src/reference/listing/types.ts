import type { QueryConventions } from "../query/conventions.ts"
import type { Row } from "../store-api.ts"

/** A listing request with every parameter already rewritten into the canonical grammar. */
export interface ListingRequest {
	filter?: string | undefined
	order?: string | undefined
	select?: string | undefined
	q?: string | undefined
	searchMode?: string | undefined
	limit?: string | undefined
	page?: string | undefined
	offset?: string | undefined
	cursor?: string | undefined
}

export interface ListingOptions {
	/** Parent constraints from the path: `{ project_id, table_id }`. */
	scope: Record<string, string | number>
	conventions: QueryConventions
	/**
	 * A ceiling the server applies without documenting it. A request above it is served a short
	 * page rather than rejected — the "clamps silently" behavior many real APIs have.
	 */
	clampLimit?: number | undefined
	/** Applied to each row before projection; the listing-only skew and job progress hook in here. */
	transform?: ((row: Row) => Row) | undefined
	/** Loads the record a relation names for `row`, for a nested select such as `table(name)`. */
	embed?: ((relation: string, row: Row) => Promise<Row | null>) | undefined
}

export interface ListingResult {
	items: Row[]
	count: number
	hasMore: boolean
	nextCursor: string | null
	page: number | null
	offset: number
	limit: number
}
