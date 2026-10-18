import { describe, expect, it } from "vitest"
import type { Record_ } from "../../../world/records.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { applyOrder, NOTES, PARAMS, queryDoc, queryOf, stage } from "../composition/__fixtures__/query-api.ts"
import { growing, ignoring, LATECOMER, refusingAfter, refusingOrder } from "./__fixtures__/sort-api.ts"
import { sortReverseSymmetry } from "./sort-reverse-symmetry.ts"

/* Every record scored, so the nullable field gives way to the title. */
const scored = NOTES.map((row, index) => ({ ...row, score: index }))

/* The correct order for each direction, then `bend` applied to the descending one. */
const bending =
	(bend: (rows: Record_[]) => Record_[], asc: (rows: Record_[]) => Record_[] = (rows) => rows): Responder =>
	(_method, _path, options) => {
		const order = queryOf(options).order ?? ""
		const rows = applyOrder(NOTES, order) ?? []
		return { body: order.endsWith(".desc") ? bend(rows) : asc(rows), status: 200 }
	}

const shorter = bending((rows) => rows.slice(1))
const swapped = bending((rows) => [...rows.slice(1), LATECOMER])
const doubledDesc = bending((rows) => [...rows.slice(1), rows[1] as Record_])
const doubledAsc = bending(
	(rows) => rows,
	(rows) => [...rows.slice(1), rows[1] as Record_],
)
const sameBothWays: Responder = (_method, _path, options) => ({
	body: applyOrder(NOTES, (queryOf(options).order ?? "").replace(".desc", ".asc")),
	status: 200,
})

describe("sort.reverse-symmetry passes", () => {
	it("passes a nullable field whose values reverse, wherever the tied nulls land", async () => {
		const staged = stage(sortReverseSymmetry)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["score.asc", "score.desc"])
	})

	it("passes a field whose records reverse exactly", async () => {
		const staged = stage(sortReverseSymmetry, { rows: scored })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["title.asc", "title.desc"])
	})
})

describe("sort.reverse-symmetry fails", () => {
	it("fails directions that return different numbers of records", async () => {
		const staged = stage(sortReverseSymmetry, { respond: shorter })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toBe("order=score.asc returned 6, order=score.desc returned 5")
		expect(staged.sent).toHaveLength(4)
	})

	it("reports directions that disagree on membership, and returns asserted", async () => {
		const staged = stage(sortReverseSymmetry, { respond: swapped })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.findings.findings[0]?.summary).toBe("ascending and descending sorts return different sets")
		expect(staged.findings.findings[0]?.detail).toContain("Only ascending: n1. Only descending: n9.")
	})

	it("names no record on a side whose only difference is a repeat", async () => {
		const desc = stage(sortReverseSymmetry, { respond: doubledDesc })
		await desc.run()
		expect(desc.findings.findings[0]?.detail).toContain("Only ascending: n1. Only descending: —.")
		const asc = stage(sortReverseSymmetry, { respond: doubledAsc })
		await asc.run()
		expect(asc.findings.findings[0]?.detail).toContain("Only ascending: —. Only descending: n3.")
	})

	it("fails a descending order that is not the ascending one reversed", async () => {
		const staged = stage(sortReverseSymmetry, { respond: sameBothWays })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail:
				"order=score.asc gives 1, 3, 5, 7…, but order=score.desc reversed gives 7, 5, 3, 1…. " +
				"One direction applies a different ordering than the other.",
			summary: "descending order is not ascending order reversed",
		})
	})
})

describe("sort.reverse-symmetry gives up", () => {
	it("is unresolved when one direction is refused", async () => {
		const staged = stage(sortReverseSymmetry, { respond: refusingOrder("score.desc") })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("one direction") })
	})

	it("is unresolved when a walk cannot reach the end of the set", async () => {
		const staged = stage(sortReverseSymmetry, { doc: queryDoc({}, [...PARAMS, "page"]), respond: ignoring("page") })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("windows") })
	})

	it("is unresolved when the collection grows between the reads", async () => {
		const staged = stage(sortReverseSymmetry, { respond: growing(1) })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("gained or lost") })
	})

	it("is unresolved when a repeat read is refused", async () => {
		const staged = stage(sortReverseSymmetry, { respond: refusingAfter(2, growing(1)) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: 'ordering by "score" was rejected on a repeat read',
		})
	})
})

describe("sort.reverse-symmetry plans", () => {
	it("orders by the identity when it is the one sortable field", () => {
		const staged = stage(sortReverseSymmetry, { doc: queryDoc({ sortable: ["id"] }), rows: scored })
		expect(staged.plan()).toEqual({ ok: true, value: { field: "id" } })
	})

	it("stands down with one record or no sortable field", async () => {
		const lone = stage(sortReverseSymmetry, { rows: NOTES.slice(0, 1) })
		expect(await lone.run()).toEqual({ kind: "stood-down", reason: "an `order` parameter supporting asc and desc" })
		expect(stage(sortReverseSymmetry, { doc: queryDoc({ sortable: [] }) }).plan().ok).toBe(false)
		expect(stage(sortReverseSymmetry, { fields: { query: null } }).plan().ok).toBe(false)
	})
})
