import { describe, expect, it } from "vitest"
import { fieldsAllowing, knownHits, pickFieldForOp, pickOrderedField } from "./fields.ts"
import { stage, without } from "./__fixtures__/widgets.ts"

const DOC = {
	xQuery: {
		filterable: [
			{ field: "status", ops: ["eq"] },
			{ field: "name", ops: ["eq", "in"] },
			{ field: "note", ops: ["eq", "in"] },
		],
	},
}

describe("fieldsAllowing", () => {
	it("lists the fields that allow an operator the grammar can write", () => {
		const { ctx } = stage({ doc: DOC, records: [] })
		expect(fieldsAllowing(ctx, "in").map((field) => field.field)).toEqual(["name", "note"])
	})

	it("is empty when the grammar cannot write the operator", () => {
		expect(fieldsAllowing(stage({ conventions: without("in"), doc: DOC, records: [] }).ctx, "in")).toEqual([])
	})
})

describe("knownHits", () => {
	it("keeps only the identities oat seeded", () => {
		const { ctx } = stage({ doc: DOC, records: [{ id: "w-1" }, { id: "w-2" }] })
		expect(knownHits([{ id: "w-2" }, { id: "x-1" }, {}], ctx)).toEqual(new Set(["w-2"]))
	})
})

describe("pickFieldForOp", () => {
	it("picks the first allowing field with enough distinct non-null values", () => {
		const records = [
			{ id: "w-1", name: "a", note: "x" },
			{ id: "w-2", name: "a", note: null },
			{ id: "w-3", name: "a", note: "y" },
		]
		const { ctx } = stage({ doc: DOC, records })
		expect(pickFieldForOp(ctx, "in")).toEqual({
			field: { field: "note", ops: ["eq", "in"], type: "string" },
			values: ["x", "y"],
		})
		expect(pickFieldForOp(ctx, "in", 1)).toMatchObject({ field: { field: "name" }, values: ["a"] })
		expect(pickFieldForOp(ctx, "in", 3)).toBeNull()
	})
})

describe("pickOrderedField", () => {
	it("picks a numeric field allowing gt, lt and eq with three numbers, once per cohort", () => {
		const doc = {
			xQuery: {
				filterable: [
					{ field: "status", ops: ["eq", "gt", "lt"] },
					{ field: "score", ops: ["eq", "gt"], type: "number" },
					{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" },
					{ field: "id", ops: ["eq", "gt", "lt"] },
				],
			},
		}
		const records = [
			{ amount: 1, id: "w-1", score: 1, status: "a" },
			{ amount: 2, id: "w-2", score: 2, status: "b" },
			{ amount: 3, id: "w-3", score: 3, status: "c" },
		]
		const { ctx } = stage({ doc, records })
		const picked = pickOrderedField(ctx)
		expect(picked).toMatchObject({ field: { field: "amount" }, values: [1, 2, 3] })
		expect(pickOrderedField(ctx)).toBe(picked)
	})

	it("is null without three numbers on such a field", () => {
		const doc = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" }] } }
		const { ctx } = stage({
			doc,
			records: [
				{ amount: 1, id: "w-1" },
				{ amount: 2, id: "w-2" },
			],
		})
		expect(pickOrderedField(ctx)).toBeNull()
	})

	it("considers an untyped field by the numbers it holds", () => {
		const { ctx } = stage({
			doc: { xQuery: { filterable: [{ field: "rank", ops: ["eq", "gt", "lt"] }] } },
			records: [1, 2, 3].map((rank) => ({ id: `w-${rank}`, rank })),
		})
		expect(pickOrderedField(ctx)).toMatchObject({ field: { field: "rank" }, values: [1, 2, 3] })
	})
})
