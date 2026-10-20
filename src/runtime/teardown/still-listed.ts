/**
 * Which of a group's records its list still holds, read page by page as the list declares its
 * paging, until the list ends or every one of them has been seen.
 */

import { largestPageQuery } from "../../spec/graph/paging.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import type { Exchange } from "../exchange.ts"
import { FencedError } from "../fence.ts"
import { isNetworkError } from "../../errors/network.ts"
import { readPath } from "../../client/read-path.ts"
import { idOf, recordsFromList } from "../world/records.ts"
import type { Disposable, Owner } from "./types.ts"

/* The most pages one re-list reads: teardown looks for its own records, it does not crawl. */
const VERIFY_PAGES = 50

/** Removed records that lived in one list, as one creator reads it. */
export interface ListGroup {
	identity: string
	listOp: OperationModel
	owner: Owner
	path: string
	items: Disposable[]
}

type Paging = OperationModel["conventions"]

/** How far a re-list has read. */
interface Walk {
	wanted: ReadonlySet<string>
	listed: Set<string>
	seen: Set<string>
	/** The longest page served: a server may cap the size asked for without saying so. */
	fullPage: number
	/** Rows served so far, repeats included: what an offset counts. */
	served: number
	cursor: string | undefined
}

/** The group's records still listed; `null` when the first page could not be read: nothing is claimed either way. */
export async function stillListed(model: SpecModel, client: Client, group: ListGroup): Promise<Set<string> | null> {
	const paging = group.listOp.conventions
	const first = largestPageQuery(model, group.listOp)
	const walk: Walk = {
		cursor: undefined,
		fullPage: 0,
		listed: new Set(),
		seen: new Set(),
		served: 0,
		wanted: new Set(group.items.map((item) => item.id)),
	}
	for (let index = 0; index < VERIFY_PAGES; index++) {
		const query = pageQuery(paging, first, { ...walk, index })
		if (query === null) break
		let exchange: Exchange
		try {
			exchange = await client.get(group.path, {
				as: { principal: group.owner.id },
				operationId: group.listOp.operationId,
				query,
			})
		} catch (error) {
			if (!(error instanceof FencedError) && !isNetworkError(error)) throw error
			return index === 0 ? null : walk.listed
		}
		if (exchange.status >= 300) return index === 0 ? null : walk.listed
		if (!takePage(walk, group, exchange)) break
	}
	return walk.listed
}

/** The query for page `index`, or `null` when the list declares no way to ask for it. */
function pageQuery(
	paging: Paging,
	first: Record<string, string | number>,
	at: { index: number; served: number; cursor: string | undefined },
): Record<string, string | number> | null {
	const query: Record<string, string | number> = { ...first }
	if (at.index === 0) return query
	if (paging.page !== undefined) query[paging.page] = at.index + 1
	else if (paging.offset !== undefined) query[paging.offset] = at.served
	else if (paging.cursor !== undefined && at.cursor !== undefined) query[paging.cursor] = at.cursor
	else return null
	return query
}

/**
 * Reads one page into the walk; false once the list has ended: an empty page, the same page
 * again, one shorter than a full page already served, or every record seen.
 */
function takePage(walk: Walk, group: ListGroup, exchange: Exchange): boolean {
	const paging = group.listOp.conventions
	const rows = recordsFromList(exchange.responseBody, group.listOp.collection?.key ?? null)
	walk.served += rows.length
	const ids = rows.flatMap((row) => idOf(row, group.identity) ?? [])
	const fresh = ids.filter((id) => !walk.seen.has(id))
	for (const id of ids) {
		walk.seen.add(id)
		if (walk.wanted.has(id)) walk.listed.add(id)
	}
	if (fresh.length === 0 || walk.listed.size === walk.wanted.size) return false
	if (walk.fullPage > 0 && rows.length < walk.fullPage) return false
	walk.fullPage = Math.max(walk.fullPage, rows.length)
	const next =
		paging.envelope.nextCursor === undefined ? undefined : readPath(exchange.responseBody, paging.envelope.nextCursor)
	walk.cursor = typeof next === "string" && next !== "" ? next : undefined
	return true
}
