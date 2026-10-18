import { describe, expect, it } from "vitest"
import { listDoc, pagedBackend, queryOf, stage, widgets } from "./__fixtures__/paged.ts"
import { MAX_WALK_PAGES, walkPages } from "./walk.ts"

const doc = listDoc({ params: ["limit", "page", "sort"] })

describe("walkPages", () => {
	it("walks every page in order to the end of the collection", async () => {
		const rows = widgets(5)
		const { ctx, sent } = stage(doc, pagedBackend(rows), rows)
		const walk = await walkPages(ctx, 2, "name.asc")
		expect(walk.ids).toEqual(["w01", "w02", "w03", "w04", "w05"])
		expect(walk.items).toEqual(rows)
		expect(walk.truncated).toBe(false)
		expect(walk.exchanges.map((e) => e.status)).toEqual([200, 200, 200])
		expect(queryOf(sent[0]!.options)).toEqual({ limit: 2, page: 1, sort: "name.asc" })
	})

	it("keeps records a page repeats, and stops at the page cap", async () => {
		const rows = widgets(5)
		const stuck = pagedBackend(rows, (body) => ({ body: { ...body, items: rows.slice(0, 2) }, status: 200 }))
		const walk = await walkPages(stage(doc, stuck, rows).ctx, 2)
		expect(walk.ids).toHaveLength(2 * MAX_WALK_PAGES)
		expect(walk.truncated).toBe(true)
	})

	it("stops after the pages asked for", async () => {
		const rows = widgets(9)
		const walk = await walkPages(stage(doc, pagedBackend(rows), rows).ctx, 2, undefined, 2)
		expect(walk.ids).toEqual(["w01", "w02", "w03", "w04"])
		expect(walk.truncated).toBe(true)
	})

	it("reads fresh pages on every walk", async () => {
		const rows = widgets(3)
		const { ctx, sent } = stage(doc, pagedBackend(rows), rows)
		await walkPages(ctx, 2)
		const first = sent.length
		await walkPages(ctx, 2)
		expect(sent.length).toBe(2 * first)
	})
})
