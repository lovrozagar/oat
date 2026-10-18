import type { DefectSet } from "../defects/defect-set.ts"
import type { ParseContext } from "../query/conventions.ts"
import type { Collation } from "../query-types.ts"
import { type Row, SqlError } from "../store-api.ts"
import type { Paging } from "./params.ts"

/** Where a page starts, and its number where the request paged by number. */
export interface WindowStart {
	offset: number
	page: number | null
}

export function invert(collation: Collation): Collation {
	return collation === "binary" ? "insensitive" : "binary"
}

/** Where a cursor page starts: just past the row the cursor names, in `ordered`. */
export function cursorOffset(
	{ defects, entity }: Pick<ParseContext, "defects" | "entity">,
	ordered: Row[],
	afterId: string,
): number {
	const index = ordered.findIndex((row) => String(row[entity.identity]) === afterId)
	if (index === -1) throw new SqlError("invalid_cursor", "cursor does not point into this collection")
	return index + (defects.has("CURSOR_DRIFT") ? 0 : 1)
}

/** Where an offset or numbered page starts over `total` rows. */
export function numberedStart(paging: Paging, total: number, defects: DefectSet): WindowStart {
	if (paging.offset !== undefined) {
		return { offset: paging.offset + (defects.has("OFF_BY_ONE_PAGE") && paging.offset > 0 ? 1 : 0), page: null }
	}
	const page = paging.page ?? 1
	const limit = paging.servedLimit
	let offset = (page - 1) * limit + (defects.has("OFF_BY_ONE_PAGE") && page > 1 ? 1 : 0)
	/* A page past the end served as the last page again, instead of empty. */
	if (defects.has("PAGE_PAST_END_REPEATS") && offset >= total && total > 0) {
		offset = (Math.ceil(total / limit) - 1) * limit
	}
	return { offset, page }
}

/** The rows of the page: `limit` from `offset`, or every row from it when the limit is ignored. */
export function cut(ctx: Pick<ParseContext, "defects">, rows: Row[], { offset }: WindowStart, limit: number): Row[] {
	return ctx.defects.has("LIMIT_IGNORED") ? rows.slice(offset) : rows.slice(offset, offset + limit)
}

/**
 * The window after a predicate applied to it alone: FILTER_AFTER_PAGINATION. The empty-result
 * guard looks at what is about to be returned, wherever the filter ran.
 */
export function filteredWindow(
	{ defects, entity }: Pick<ParseContext, "defects" | "entity">,
	window: Row[],
	matching: Row[],
): Row[] {
	const allowed = new Set(matching.map((row) => String(row[entity.identity])))
	const filtered = window.filter((row) => allowed.has(String(row[entity.identity])))
	return defects.has("EMPTY_RESULT_RETURNS_ALL") && filtered.length === 0 ? window : filtered
}
