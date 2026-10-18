import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { dropWhen, fleetingSelect } from "./__fixtures__/composition-b.ts"
import { NOTES, queryDoc, REJECT, stage } from "./__fixtures__/query-api.ts"
import { querySortAndSelectCompose } from "./query-sort-and-select-compose.ts"

/* A listing whose first record is null. */
const nullFirst: Responder = () => ({ body: [null, { id: "n1", title: "Alpha report" }], status: 200 })

/* A listing of one record. */
const single: Responder = () => ({ body: [{ id: "n1", title: "Alpha report" }], status: 200 })

describe("query.sort-and-select-compose judges", () => {
	it("passes a backend that keeps its order under a projection", async () => {
		const staged = stage(querySortAndSelectCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ limit: 20, order: "title.asc", select: "id,title" },
		])
	})

	it("fails an order dropped when a select is present", async () => {
		const staged = stage(querySortAndSelectCompose, { respond: dropWhen("order", "select") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: "order=title.asc did not hold under the projection.",
			summary: "sort and select do not compose",
		})
		expect(staged.findings.findings[0]?.evidence).toHaveLength(1)
	})

	it("fails a projection that leaks fields once an order is present", async () => {
		const staged = stage(querySortAndSelectCompose, { respond: dropWhen("select", "order") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toBe("select leaked author, rank, score, status.")
	})
})

describe("query.sort-and-select-compose gives up", () => {
	it("is unresolved when the probe is refused or lists fewer than two records", async () => {
		const reason = { kind: "unresolved", reason: "sort+select probe was rejected" }
		expect(await stage(querySortAndSelectCompose, { respond: () => REJECT }).run()).toEqual(reason)
		expect(await stage(querySortAndSelectCompose, { respond: single }).run()).toEqual(reason)
	})
})

describe("query.sort-and-select-compose on a null record", () => {
	it("reports a listing that holds a null record instead of throwing", async () => {
		await expect(stage(querySortAndSelectCompose, { respond: nullFirst }).run()).resolves.toMatchObject({
			kind: "unresolved",
		})
	})
})

describe("query.sort-and-select-compose plans", () => {
	it("projects the sort field beside the identity, or the identity alone when it is the sort field", () => {
		expect(stage(querySortAndSelectCompose).plan()).toEqual({
			ok: true,
			value: { field: "title", projection: { select: "id,title" }, requested: ["id", "title"] },
		})
		expect(stage(querySortAndSelectCompose, { doc: queryDoc({ sortable: ["id"] }) }).plan()).toEqual({
			ok: true,
			value: { field: "id", projection: { select: "id" }, requested: ["id"] },
		})
	})

	it("stands down without an order or a select parameter, or with one record", () => {
		const noOrder = queryDoc({}, ["filter", "select", "q", "limit"])
		const noSelect = queryDoc({}, ["filter", "order", "q", "limit"])
		for (const doc of [noOrder, noSelect])
			expect(stage(querySortAndSelectCompose, { doc }).plan()).toEqual({ ok: false })
		expect(stage(querySortAndSelectCompose, { rows: NOTES.slice(0, 1) }).plan()).toEqual({ ok: false })
	})

	it("stands down without selectable or sortable fields", () => {
		expect(stage(querySortAndSelectCompose, { doc: queryDoc({ selectable: [] }) }).plan()).toEqual({ ok: false })
		expect(stage(querySortAndSelectCompose, { doc: queryDoc({ sortable: [] }) }).plan()).toEqual({ ok: false })
		expect(stage(querySortAndSelectCompose, { fields: { query: null } }).plan()).toEqual({ ok: false })
	})

	it("stands down when the select grammar cannot write the projection", async () => {
		const staged = stage(querySortAndSelectCompose, { fields: fleetingSelect() })
		expect(await staged.run()).toEqual({ kind: "stood-down", reason: "sortable and selectable fields" })
		expect(staged.sent).toEqual([])
	})
})
