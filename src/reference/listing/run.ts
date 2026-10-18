/**
 * A collection read, end to end, above any store.
 *
 * The store answers one question — which rows match, in what order — and everything a listing
 * adds on top is decided here once: validating the paging parameters, resolving a cursor, cutting
 * the window, counting, projecting a sparse fieldset. Every defect that corrupts one of those
 * steps is applied here too, so a broken count or an off-by-one page is the same bug on every
 * engine rather than three bugs that happen to share a name.
 */

import type { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef } from "../model/types.ts"
import { and } from "../query/tree.ts"
import type { Collation, FilterNode, OrderTerm, SelectPlan } from "../query-types.ts"
import { decodeCursor, encodeCursor, type Row, type Store } from "../store-api.ts"
import { listingOrder } from "./order.ts"
import { pagingOf } from "./params.ts"
import { type ListingPredicate, listingPredicate } from "./predicate.ts"
import { project } from "./project.ts"
import type { ListingOptions, ListingRequest, ListingResult } from "./types.ts"
import { cursorOffset, cut, filteredWindow, invert, numberedStart, type WindowStart } from "./window.ts"

/** One listing to run: the entity, the request in the canonical grammar, the options, the defects. */
export interface Listing {
	entity: EntityDef
	request: ListingRequest
	options: ListingOptions
	defects: DefectSet
}

/*
 * Every await of a listing is here, in the order the stores are asked: the rows, the empty-result
 * fallback, the count, the cursor's other collation, the post-paging filter, the projections.
 * Everything between them is synchronous, so the await sequence is the listing's own.
 */
export async function runListing(store: Store, { entity, request, options, defects }: Listing): Promise<ListingResult> {
	const ctx = { conventions: options.conventions, defects, entity }
	const paging = pagingOf(entity, request, options, defects)
	const predicate = listingPredicate(request, options, ctx)
	const { filter, scope, scoped, search, tombstones } = predicate
	const { dropNulls, fullOrder, unstable } = listingOrder(request, ctx, predicate.axes)
	const plan = planner(fullOrder, unstable, options.conventions.collation)
	/* Paging before filtering: the window is cut from the unfiltered set and the predicate is then
	 * applied to whatever that window held. */
	const pageBeforeFilter = defects.has("FILTER_AFTER_PAGINATION") && filter !== null
	const listingWhere = and(...scoped, tombstones, pageBeforeFilter ? null : filter, search, ...dropNulls)
	let rows = await store.select(entity, plan(listingWhere))
	if (fallsBackToAll(defects, rows, predicate)) rows = await store.select(entity, plan(and(...scope, tombstones)))
	const count = defects.has("COUNT_ALWAYS_ZERO")
		? 0
		: defects.has("COUNT_IGNORES_FILTER")
			? (await store.select(entity, plan(and(...scope, tombstones)))).length
			: rows.length
	let start: WindowStart
	if (request.cursor !== undefined && request.cursor !== "") {
		const afterId = decodeCursor(request.cursor)
		/* The boundary must be resolved under exactly the listing's ordering. Under the defect it
		 * is resolved under the other collation, and that position is then used as an offset into
		 * the listing — a boundary the listing never had, so rows are skipped or repeated. */
		const ordered = defects.has("COLLATION_INCONSISTENT")
			? await store.select(entity, plan(listingWhere, invert(options.conventions.collation)))
			: rows
		start = { offset: cursorOffset(ordered, afterId, entity, defects), page: null }
	} else start = numberedStart(paging, rows.length, defects)
	let window = cut(rows, start, paging.servedLimit, defects)
	if (pageBeforeFilter) {
		const matching = await store.select(entity, plan(and(...scoped, tombstones, filter, search)))
		window = filteredWindow(window, matching, entity, defects)
	}
	const projection = { defects, embed: options.embed, entity, select: request.select }
	const items = await Promise.all(
		window
			.map((row) => (options.transform === undefined ? row : options.transform(row)))
			.map((row) => project(row, projection)),
	)
	return listingResult({ count, items, rows, start, window }, paging.servedLimit, entity, defects)
}

/* The select plan for a predicate: the listing's order, under its collation unless told another. */
function planner(
	order: OrderTerm[],
	unstable: boolean,
	listing: Collation,
): (where: FilterNode, collation?: Collation) => SelectPlan {
	return (where, collation = listing) => ({ collation, order, shuffleTies: unstable, where })
}

/* The "no results must mean the query was wrong" guard: an empty filtered set falls back to the
 * unfiltered listing, which makes an empty result impossible to express. */
function fallsBackToAll(defects: DefectSet, rows: Row[], { filter, search }: ListingPredicate): boolean {
	return defects.has("EMPTY_RESULT_RETURNS_ALL") && rows.length === 0 && (filter !== null || search !== null)
}

/* What the listing answers: the rows served, the count, and where the page sits among the rest. */
function listingResult(
	{
		count,
		items,
		rows,
		start,
		window,
	}: { count: number; items: Row[]; rows: Row[]; start: WindowStart; window: Row[] },
	limit: number,
	entity: EntityDef,
	defects: DefectSet,
): ListingResult {
	const hasMore = defects.has("HASMORE_ALWAYS_FALSE") ? false : start.offset + window.length < rows.length
	const last = window.at(-1)
	return {
		count,
		hasMore,
		items,
		limit,
		nextCursor: hasMore && last !== undefined ? encodeCursor(String(last[entity.identity])) : null,
		offset: start.offset,
		page: start.page,
	}
}
