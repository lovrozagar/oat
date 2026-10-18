import { describe, expect, it } from "vitest"
import type { Record_ } from "../../../world.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { memoTable } from "../../sets/read.ts"
import { backend, NOTES, queryDoc, queryOf, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { orderChangesResult } from "./sort-order-is-applied.ts"

/* The backend with the order parameter dropped: it serves `rows` in their own sequence. */
const ignoringOrder =
	(rows: readonly Record_[]): Responder =>
	(method, path, options) => {
		const { order: _dropped, ...rest } = queryOf(options)
		return backend(rows)(method, path, { query: rest })
	}

const byTitle = NOTES.toSorted((a, b) => (String(a.title) < String(b.title) ? -1 : 1))

/* Sorted by title whatever is asked, and refusing a descending order. */
const refusingDescending: Responder = (method, path, options) =>
	queryOf(options).order === "title.desc" ? REJECT : ignoringOrder(byTitle)(method, path, options)

/* Every record without its title. */
const untitled: Responder = () => ({ body: NOTES.map(({ title: _title, ...rest }) => rest), status: 200 })

describe("sort.order-is-applied judges", () => {
	it("passes a backend that sorts both ways, and remembers the text order it showed", async () => {
		const staged = stage(orderChangesResult)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["title.asc", "title.desc"])
		expect(memoTable(staged.ctx.memo.entity, "textOrders").get("title")).toEqual({ text: "binary" })
		expect(staged.findings.findings).toEqual([])
	})

	it("fails an order that is accepted and ignored, when the fixed order happens to ascend", async () => {
		const staged = stage(orderChangesResult, { respond: ignoringOrder(byTitle), rows: byTitle })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("order is accepted but has no effect")
		expect(staged.findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("fails an ascending order that comes back unsorted", async () => {
		const staged = stage(orderChangesResult, { respond: ignoringOrder(NOTES) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("order is accepted but the result is not sorted")
		expect(staged.findings.findings[0]?.detail).toContain('"Alpha report", "Beta report", "Alpha memo"')
		expect(staged.sent).toHaveLength(1)
	})
})

describe("sort.order-is-applied tolerates", () => {
	it("passes a fixed order on a field holding one value: equal keys are sorted both ways", async () => {
		const rows = NOTES.map((row) => ({ ...row, title: "same" }))
		const staged = stage(orderChangesResult, { respond: ignoringOrder(rows), rows })
		expect(await staged.run()).toEqual({ kind: "asserted" })
	})

	it("passes when the descending read is refused after a sorted ascending one", async () => {
		const staged = stage(orderChangesResult, { respond: refusingDescending, rows: byTitle })
		expect(await staged.run()).toEqual({ kind: "asserted" })
	})
})

describe("sort.order-is-applied gives up", () => {
	it("is unresolved when the sorted listing is refused or holds fewer than two records", async () => {
		const refused = stage(orderChangesResult, { respond: () => REJECT })
		expect(await refused.run()).toMatchObject({ kind: "unresolved" })
		const short = stage(orderChangesResult, { respond: () => ({ body: [NOTES[0]], status: 200 }) })
		expect(await short.run()).toEqual({
			kind: "unresolved",
			reason: "the sorted listing was rejected or held fewer than two records",
		})
	})

	it("is unresolved when the listed records lack the sort field", async () => {
		const staged = stage(orderChangesResult, { respond: untitled })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the sort field is absent from the listed records",
		})
	})
})

describe("sort.order-is-applied plans", () => {
	it("sorts by the identity only when it is the one sortable field", () => {
		const staged = stage(orderChangesResult, { doc: queryDoc({ sortable: ["id"] }) })
		expect(staged.plan()).toEqual({ ok: true, value: { field: "id" } })
	})

	it("stands down without a sortable field or with two records or fewer", async () => {
		expect(stage(orderChangesResult, { doc: queryDoc({ sortable: [] }) }).plan().ok).toBe(false)
		const few = stage(orderChangesResult, { rows: NOTES.slice(0, 2) })
		expect(await few.run()).toEqual({ kind: "stood-down", reason: "an `order` parameter and a sortable field" })
		expect(few.sent).toEqual([])
	})
})
