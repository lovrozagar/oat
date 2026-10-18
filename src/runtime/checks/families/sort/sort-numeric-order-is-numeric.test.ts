import { describe, expect, it, vi } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { NOTES, PARAMS, queryDoc, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import type { SetRead } from "../../sets/read.ts"
import { sortNumericOrderIsNumeric } from "./sort-numeric-order-is-numeric.ts"

/* A read the next readSet call returns instead of reading: what no real walk produces. */
const planted = vi.hoisted(() => ({ read: undefined as SetRead | undefined }))

vi.mock("../../sets/read.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../sets/read.ts")>()
	return {
		...actual,
		readSet: (...args: Parameters<typeof actual.readSet>) => {
			const read = planted.read
			planted.read = undefined
			return read === undefined ? actual.readSet(...args) : Promise.resolve(read)
		},
	}
})

/* Orders rank by its text: 10 before 2. */
const byText: Responder = () => ({
	body: NOTES.toSorted((a, b) => String(a.rank).localeCompare(String(b.rank))),
	status: 200,
})

describe("sort.numeric-order-is-numeric judges", () => {
	it("passes a backend that orders a number as a number", async () => {
		const staged = stage(sortNumericOrderIsNumeric)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["rank.asc"])
	})

	it("fails a backend that orders a number as text", async () => {
		const staged = stage(sortNumericOrderIsNumeric, { respond: byText })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: "order=rank.asc returned 10, 100, 2, 2, 33, 9.",
			evidence: [{ status: 200 }],
			summary: '"rank" is sorted as text rather than as a number',
		})
	})

	it("is unresolved when the sorted listing is refused", async () => {
		const staged = stage(sortNumericOrderIsNumeric, { respond: () => REJECT })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "page 1 was answered with 400" })
	})
})

describe("sort.numeric-order-is-numeric without a stated reason", () => {
	it("is unresolved with its own reason when an unresolved read gives none", async () => {
		const staged = stage(sortNumericOrderIsNumeric)
		planted.read = { complete: false, items: [], pages: [], status: "unresolved" } as unknown as SetRead
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "the sorted listing was rejected" })
		expect(staged.sent).toEqual([])
	})
})

describe("sort.numeric-order-is-numeric plans", () => {
	it("stands down without a field whose text order differs from its numeric one", async () => {
		const agreeing = NOTES.map((row, index) => ({ ...row, rank: index + 1 }))
		const staged = stage(sortNumericOrderIsNumeric, { rows: agreeing })
		expect(await staged.run()).toEqual({
			kind: "stood-down",
			reason: "a numeric sortable field whose lexical order disagrees with numeric order",
		})
		expect(stage(sortNumericOrderIsNumeric, { rows: NOTES.slice(0, 2) }).plan().ok).toBe(false)
	})

	it("stands down without an order parameter", () => {
		const doc = queryDoc(
			{},
			PARAMS.filter((name) => name !== "order"),
		)
		expect(stage(sortNumericOrderIsNumeric, { doc }).plan().ok).toBe(false)
	})
})
