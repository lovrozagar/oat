import { describe, expect, it } from "vitest"
import type { Sent } from "../__fixtures__/harness.ts"
import { BARE, notesContext, withConventions } from "../query/__fixtures__/notes.ts"
import { memoTable, readSet } from "./read.ts"
import { cursored, rows, served } from "./__fixtures__/serve.ts"

/*
 * `readSet` walks a whole result set however the list pages, and calls it complete only on
 * evidence the API gave: an empty page, a page shorter than a full one, a total reached, no next
 * cursor. A refused page leaves the set unresolved, never ended; a wrong "no more" on a full page
 * is checked by reading one more page.
 */

const asked = (sent: Sent[], name: string) => sent.map((request) => request.options.query?.[name])
const idsOf = (items: Array<Record<string, unknown>>) => items.map((item) => item.id)

const ENVELOPED = { envelope: { hasMore: "more", total: "total" } }

describe("readSet by page number", () => {
	it("walks to a short page, fetching the next few pages together", async () => {
		const { ctx, sent } = notesContext(served(rows(7)))
		const read = await readSet(ctx)
		expect(read).toMatchObject({ complete: true, status: "ok" })
		expect(idsOf(read.items)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7"])
		expect(read.pages).toHaveLength(3)
		expect(read.last).toBe(read.pages[2])
		/* Pages 2–5 go out together after page 1, and page 6 once page 3 is reached. */
		expect(asked(sent, "page")).toEqual([1, 2, 3, 4, 5, 6])
		expect(new Set(asked(sent, "limit"))).toEqual(new Set([3]))
	})

	it("is complete and empty on an empty first page", async () => {
		const { ctx } = notesContext(served([]))
		expect(await readSet(ctx)).toMatchObject({ complete: true, items: [], status: "ok" })
	})

	it("is unresolved, not ended, when a page is refused", async () => {
		const { ctx } = notesContext((method, path, options) =>
			options.query?.page === 2 ? { status: 500 } : served(rows(7))(method, path, options),
		)
		const read = await readSet(ctx)
		expect(read).toMatchObject({ complete: false, reason: "page 2 was answered with 500", status: "unresolved" })
		expect(read.items).toHaveLength(3)
		expect(read.last.exchange.status).toBe(500)
	})

	it("stops, incomplete, when the server serves the same window for every page", async () => {
		const { ctx } = notesContext(() => ({ body: rows(3), status: 200 }))
		expect(await readSet(ctx)).toMatchObject({ complete: false, reason: "pages repeat the same records" })
	})

	it("keeps repeats when asked, up to the page cap, fetching no page past it", async () => {
		const { ctx, sent } = notesContext(() => ({ body: rows(3), status: 200 }))
		const read = await readSet(ctx, {}, { keepRepeats: true, maxPages: 2 })
		expect(read).toMatchObject({ complete: false, reason: "stopped after 2 page(s)", status: "ok" })
		expect(read.items).toHaveLength(6)
		expect(asked(sent, "page")).toEqual([1, 2])
	})

	it("reports a set larger than it gathers", async () => {
		const { ctx } = notesContext(served(rows(600)))
		const read = await readSet(ctx)
		expect(read).toMatchObject({ complete: false, reason: "more than 500 records" })
		expect(read.items).toHaveLength(501)
	})

	it("never lets a page fetched past the end surface its failure", async () => {
		const { ctx } = notesContext((method, path, options) => {
			if (Number(options.query?.page) > 2) throw new Error("past the end")
			return served(rows(4))(method, path, options)
		})
		expect(await readSet(ctx)).toMatchObject({ complete: true, status: "ok" })
	})
})

/** A list of three rows under `items`, each page's envelope made by `wrap`. */
function enveloped(wrap: (page: Array<Record<string, unknown>>) => Record<string, unknown>) {
	return notesContext(served(rows(3), { wrap: (page) => ({ body: wrap(page), status: 200 }) }), {
		collectionKey: "items",
	})
}

describe("readSet's evidence of the end", () => {
	it("believes a total reached on a short page", async () => {
		const { ctx, sent } = enveloped((page) => ({ items: page.slice(0, 2), total: 2 }))
		expect(await readSet(withConventions(ctx, ENVELOPED))).toMatchObject({ complete: true })
		expect(sent).toHaveLength(1)
	})

	it("believes no-more on a short page", async () => {
		const { ctx, sent } = enveloped((page) => ({ items: page.slice(0, 2), more: false }))
		expect(await readSet(withConventions(ctx, ENVELOPED))).toMatchObject({ complete: true })
		expect(sent).toHaveLength(1)
	})

	it("reads one more page when the end is claimed on a full page", async () => {
		const { ctx, sent } = enveloped((page) => ({ items: page, more: false, total: 3 }))
		expect(await readSet(withConventions(ctx, ENVELOPED))).toMatchObject({ complete: true })
		expect(asked(sent, "page")[1]).toBe(2)
	})

	it("believes neither signal when the total and no-more disagree", async () => {
		const { ctx, sent } = enveloped((page) => ({ items: page.slice(0, 2), more: true, total: 2 }))
		expect(await readSet(withConventions(ctx, ENVELOPED))).toMatchObject({ complete: true })
		expect(asked(sent, "page")[1]).toBe(2)
	})

	it("reads on when the page is short but nothing says the set ended", async () => {
		const { ctx, sent } = notesContext(served(rows(2)))
		expect(await readSet(ctx, {}, { size: 3 })).toMatchObject({ complete: true })
		expect(asked(sent, "page")[1]).toBe(2)
	})
})

describe("readSet by offset", () => {
	it("offsets by the records actually returned when the server serves fewer than asked", async () => {
		const { ctx, sent } = notesContext(served(rows(5), { serves: 2 }))
		const read = await readSet(withConventions(ctx, { offset: "offset", page: undefined }))
		expect(read).toMatchObject({ complete: true })
		expect(read.items).toHaveLength(5)
		expect(asked(sent, "offset")).toEqual([0, 2, 4])
	})
})

describe("readSet by cursor", () => {
	const CURSOR = { cursor: "cursor", envelope: { nextCursor: "next" }, page: undefined }

	it("follows the next cursor until there is none", async () => {
		const { ctx, sent } = notesContext(cursored(rows(5)), { collectionKey: "items" })
		const read = await readSet(withConventions(ctx, CURSOR))
		expect(read).toMatchObject({ complete: true })
		expect(read.items).toHaveLength(5)
		expect(asked(sent, "cursor")).toEqual([undefined, "2", "4"])
	})

	it("ends at an empty next cursor", async () => {
		const { ctx, sent } = notesContext(cursored(rows(3), ""), { collectionKey: "items" })
		expect(await readSet(withConventions(ctx, CURSOR))).toMatchObject({ complete: true })
		expect(sent).toHaveLength(2)
	})

	it("pages by cursor where page numbers exist too only when asked", async () => {
		const both = { cursor: "cursor", envelope: { nextCursor: "next" } }
		const { ctx, sent } = notesContext(cursored(rows(3)), { collectionKey: "items" })
		await readSet(withConventions(ctx, both), {}, { byCursor: true })
		expect(asked(sent, "page")).toEqual([undefined, undefined])
		const paged = notesContext(served(rows(2)))
		await readSet(paged.ctx, {}, { byCursor: true })
		expect(asked(paged.sent, "page")[0]).toBe(1)
	})
})

describe("readSet on a list that does not page", () => {
	it("reads once and takes the one page as the set, identity or not", async () => {
		const { ctx, sent } = notesContext(() => ({ body: [{ name: "a" }, { name: "b" }], status: 200 }))
		const read = await readSet(withConventions(ctx, BARE))
		expect(read).toMatchObject({ complete: true })
		expect(read.items).toHaveLength(2)
		expect(sent).toHaveLength(1)
	})
})

describe("readSet's request", () => {
	it("asks for the given size and order, as the given principal and scope, never past the maximum", async () => {
		const { ctx, sent } = notesContext(served([]))
		await readSet(ctx, { filter: "x" }, { order: "name.asc", principal: "b", scope: {}, size: 2 })
		expect(sent[0]?.options).toMatchObject({
			as: { principal: "b" },
			query: { filter: "x", limit: 2, sort: "name.asc" },
		})
		await readSet(ctx, {}, { size: 50 })
		expect(sent[1]?.options.query).toEqual({ limit: 3, page: 1 })
	})
})

describe("readSet's memo", () => {
	it("shares an identical read until something is written", async () => {
		const { ctx, sent } = notesContext(served(rows(2)))
		await Promise.all([readSet(ctx), readSet(ctx)])
		/* One walk's worth: page 1, then pages 2–5 together, the first of them empty. */
		const before = sent.length
		expect(before).toBe(5)
		await readSet(ctx)
		expect(sent).toHaveLength(before)
		await readSet(ctx, { filter: "x" })
		expect(sent.length).toBeGreaterThan(before)
		const afterFilter = sent.length
		/* Another principal may see another set: its read is its own. */
		await readSet(ctx, {}, { principal: "beta" })
		expect(sent.length).toBeGreaterThan(afterFilter)
		expect(sent.at(-1)?.options.as).toEqual({ principal: "beta" })
		const afterOther = sent.length
		await ctx.client.request("POST", "/notes", { as: { principal: "alpha" } })
		await readSet(ctx)
		expect(sent.length).toBeGreaterThan(afterOther + 1)
	})

	it("reads again when asked for a fresh read, and does not keep it", async () => {
		const { ctx, sent } = notesContext(served(rows(2)))
		await readSet(ctx)
		const before = sent.length
		await readSet(ctx, {}, { fresh: true })
		expect(sent.length).toBe(before * 2)
		await readSet(ctx)
		expect(sent.length).toBe(before * 2)
	})
})

describe("memoTable", () => {
	it("makes a named table on first use and hands back the same one after", () => {
		const store = new Map<string, unknown>()
		const table = memoTable<number>(store, "t")
		table.set("a", 1)
		expect(memoTable<number>(store, "t")).toBe(table)
		expect(store.get("t")).toBe(table)
	})
})
