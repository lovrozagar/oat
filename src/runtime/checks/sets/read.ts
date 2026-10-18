import type { QueryConventions } from "../../../spec/conventions/types.ts"
import type { SortValue } from "../../../spec/render/sort.ts"
import { fillPath } from "../../fill-path.ts"
import { idOf, type Record_ } from "../../world.ts"
import type { CheckContext } from "../core/context.ts"
import { conv, pageSize, q, type Query } from "../query/capabilities.ts"
import { envelopeValue, list, type ListResult } from "./list.ts"

/**
 * What a whole-set read produced. `complete` is true only when the API itself showed the set
 * ended — see `readSet`; a read that is unresolved or incomplete always says why.
 */
export type SetRead = {
	items: Record_[]
	/** The last page read. */
	last: ListResult
	pages: ListResult[]
} & ({ status: "ok"; complete: true } | { status: "ok" | "unresolved"; complete: false; reason: string })

interface ReadOptions {
	/** Page size to ask for; never above the documented maximum. */
	size?: number
	order?: SortValue | undefined
	/** Bypass the memo: for checks that compare two reads of the same set. */
	fresh?: boolean
	/** Stop after this many pages even if the set continues. */
	maxPages?: number
	/** Keep walking when a page repeats records already seen — the page-walk check wants to see it. */
	keepRepeats?: boolean
	/** Page by cursor even where page numbers or offsets exist. */
	byCursor?: boolean
	auth?: () => Record<string, string>
	scope?: Record<string, string>
}

/** One named table in a memo map, made on first use. */
export function memoTable<V>(store: Map<string, unknown>, name: string): Map<string, V> {
	const known = store.get(name) as Map<string, V> | undefined
	if (known !== undefined) return known
	const table = new Map<string, V>()
	store.set(name, table)
	return table
}

/** Page-number pages requested together once a walk is known to go past its first page. */
const PAGES_AHEAD = 4

/** Most records one set read will gather before reporting the set as larger than it covers. */
const SET_RECORD_CAP = 500

/**
 * Reads a whole result set — the one primitive every check that reasons about "all the records
 * matching X" goes through.
 *
 * It follows whatever the endpoint pages by: page numbers, row offsets, or a cursor. Offsets count
 * the records actually returned, so a server that quietly serves fewer than asked for is still
 * walked correctly. Completeness comes only from evidence the API gave: an empty page, a page
 * shorter than a full one already seen, a total reached, a missing next cursor. A "no more pages"
 * signal on a page that was full is checked by reading one more page — a wrong flag must not end
 * a walk, since a wrong flag is one of the things checks look for. The requested size proves
 * nothing on its own: a server may cap it without saying so.
 *
 * A page answered with an error leaves the set unresolved, never "ended". Identical reads are
 * shared until the next write, unless `fresh` asks for a new one.
 */
export async function readSet(ctx: CheckContext, extra: Query = {}, options: ReadOptions = {}): Promise<SetRead> {
	const size = Math.min(options.size ?? pageSize(ctx), pageSize(ctx))
	/* Identical set reads within one run, keyed by request and by how many writes came before. */
	const memo = memoTable<Promise<SetRead>>(ctx.memo.run, "setReads")
	const key = JSON.stringify([
		ctx.listOp.operationId,
		fillPath(ctx.listOp.path, options.scope ?? ctx.scope),
		(options.auth ?? ctx.auth)(),
		extra,
		size,
		options.order ?? null,
		options.maxPages ?? null,
		options.keepRepeats === true,
		options.byCursor === true,
		ctx.client.writes,
	])
	if (options.fresh !== true) {
		const cached = memo.get(key)
		if (cached !== undefined) return cached
	}
	const pending = walkSet(ctx, extra, options, size)
	if (options.fresh !== true) memo.set(key, pending)
	return pending
}

/** How a walk moves forward: the endpoint's page numbers, row offsets or cursor — or not at all. */
type PagingMode = "page" | "offset" | "cursor" | "single"

function pagingMode(c: QueryConventions, byCursor: boolean): PagingMode {
	if (byCursor && c.cursor !== undefined) return "cursor"
	if (c.page !== undefined) return "page"
	if (c.offset !== undefined) return "offset"
	return c.cursor === undefined ? "single" : "cursor"
}

/** A walk in progress: how it reads a page, and what it has gathered so far. */
interface Walk {
	ctx: CheckContext
	extra: Query
	options: ReadOptions
	size: number
	mode: PagingMode
	items: Record_[]
	pages: ListResult[]
	seen: Set<string>
	/** The longest page seen; a shorter one after it is the last. */
	fullPage: number
	cursor: string | undefined
	/** Pages requested ahead of the one being judged, by index. */
	ahead: Map<number, Promise<ListResult>>
}

async function walkSet(ctx: CheckContext, extra: Query, options: ReadOptions, size: number): Promise<SetRead> {
	const mode = pagingMode(conv(ctx), options.byCursor === true)
	const walk: Walk = {
		ahead: new Map(),
		ctx,
		cursor: undefined,
		extra,
		fullPage: 0,
		items: [],
		mode,
		options,
		pages: [],
		seen: new Set(),
		size,
	}
	const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY
	for (let index = 0; ; index++) {
		if (index >= maxPages) return finish(walk, `stopped after ${maxPages} page(s)`)
		fetchAhead(walk, index, maxPages)
		const result = await (walk.ahead.get(index) ?? fetchPage(walk, index))
		const ended = judgePage(walk, index, result)
		if (ended !== undefined) return ended
	}
}

/** The walk's end: the whole set, or, given why, a set that goes on past what was read. */
function finish(walk: Walk, cutShort?: string): SetRead {
	const read = { items: walk.items, last: walk.pages.at(-1) as ListResult, pages: walk.pages }
	return cutShort === undefined
		? { ...read, complete: true, status: "ok" }
		: { ...read, complete: false, reason: cutShort, status: "ok" }
}

function fetchPage(walk: Walk, index: number): Promise<ListResult> {
	const { ctx, mode, options } = walk
	const c = conv(ctx)
	const query: Query = {
		...q(ctx, { limit: walk.size, order: options.order }),
		...walk.extra,
	}
	if (mode === "page" && c.page !== undefined) query[c.page] = index + 1
	if (mode === "offset" && c.offset !== undefined) query[c.offset] = walk.items.length
	if (mode === "cursor" && c.cursor !== undefined && walk.cursor !== undefined) query[c.cursor] = walk.cursor
	return list(ctx, query, { auth: options.auth, scope: options.scope })
}

/*
 * Page numbers are known in advance, so once the first page shows there is more to read, the
 * next few are requested together. They are still judged one by one, in order, and whatever
 * was fetched past the end is simply not read. Offsets and cursors depend on the page before.
 */
function fetchAhead(walk: Walk, index: number, maxPages: number): void {
	if (walk.mode !== "page" || index === 0) return
	for (let next = index; next < Math.min(index + PAGES_AHEAD, maxPages); next++) {
		if (walk.ahead.has(next)) continue
		const pending = fetchPage(walk, next)
		/* A page fetched past the end is never awaited; its failure must not surface. */
		pending.catch(() => undefined)
		walk.ahead.set(next, pending)
	}
}

/** Takes one page into the walk: the finished read when it ends the walk, else `undefined`. */
function judgePage(walk: Walk, index: number, result: ListResult): SetRead | undefined {
	const { ctx, items, options, pages, seen } = walk
	pages.push(result)
	if (result.exchange.status >= 400) {
		return {
			complete: false,
			items,
			last: result,
			pages,
			reason: `page ${index + 1} was answered with ${result.exchange.status}`,
			status: "unresolved",
		}
	}
	const page = result.items
	if (page.length === 0) return finish(walk)
	const fresh = page.filter((item) => {
		const key = idOf(item, ctx.identity)
		return key === undefined || !seen.has(key)
	})
	/* A page holding nothing new means the server is not paging — the same window again. */
	if (fresh.length === 0 && options.keepRepeats !== true) return finish(walk, "pages repeat the same records")
	for (const key of page.map((item) => idOf(item, ctx.identity))) if (key !== undefined) seen.add(key)
	items.push(...page)
	if (items.length >= SET_RECORD_CAP) return finish(walk, `more than ${SET_RECORD_CAP} records`)
	if (walk.mode === "single") return finish(walk)
	return walk.mode === "cursor" ? followCursor(walk, result) : judgeEnd(walk, result)
}

/** The next cursor, or the end of the walk when the page names none. */
function followCursor(walk: Walk, result: ListResult): SetRead | undefined {
	const next = envelopeValue(walk.ctx, result, "nextCursor")
	if (typeof next !== "string" || next === "") return finish(walk)
	walk.cursor = next
	return undefined
}

/** Whether a numbered or offset page is the last, on the evidence the page and its envelope give. */
function judgeEnd(walk: Walk, result: ListResult): SetRead | undefined {
	const page = result.items
	/* A page shorter than a full one already seen is the last page. */
	if (walk.fullPage > 0 && page.length < walk.fullPage) return finish(walk)
	walk.fullPage = Math.max(walk.fullPage, page.length)
	const total = envelopeValue(walk.ctx, result, "total")
	const hasMore = envelopeValue(walk.ctx, result, "hasMore")
	/* Where the envelope carries both, they must agree before either is believed: a total of
	 * zero beside a page of rows, or "no more" short of the total, is a signal lying — and a
	 * server that serves fewer rows than asked makes every page look like the last. */
	const totalSaysDone = typeof total === "number" && walk.items.length >= total
	const saysDone =
		typeof total === "number" && typeof hasMore === "boolean"
			? totalSaysDone && !hasMore
			: totalSaysDone || hasMore === false
	/* Done, and the page was not full: the evidence agrees. Done on a full page, or nothing
	 * said at all: read one more page and let it decide. */
	return saysDone && page.length < walk.size ? finish(walk) : undefined
}
