import type { SortValue } from "../../../../spec/render/sort.ts"
import type { Listed } from "../../core/context.ts"
import { ids, type Walk } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"

/**
 * How many pages a walk will traverse.
 *
 * Walking a whole collection is O(n) strictly sequential requests, so against a large existing
 * dataset it dominates the entire run — and buys nothing. Pagination defects manifest at the
 * *first* page boundary: a missing tiebreak, an off-by-one offset, a drifting cursor all show up
 * within the first few pages or not at all. Bounding the walk makes runtime independent of how
 * much data the system under test happens to be holding.
 */
export const MAX_WALK_PAGES = 6

/** Walks pages in order, returning ids as encountered — repeats kept, since they are the finding. */
export async function walkPages(
	ctx: Listed,
	perPage: number,
	order?: SortValue,
	maxPages: number = MAX_WALK_PAGES,
): Promise<Walk> {
	const read = await readSet(ctx, {}, { fresh: true, keepRepeats: true, maxPages, order, size: perPage })
	return {
		exchanges: read.pages.map((page) => page.exchange),
		ids: ids(read.items, ctx.identity),
		items: read.items,
		truncated: !read.complete,
	}
}
