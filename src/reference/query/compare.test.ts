import { describe, expect, it } from "vitest"
import type { OrderTerm } from "../query-types.ts"
import { compareRows } from "./compare.ts"

const ROWS = [
	{ id: "a", n: 10, name: "beta", note: null },
	{ id: "b", n: 9, name: "Alpha", note: "x" },
	{ id: "c", n: null, name: "alpha", note: null },
]
const key = (field: string, extra: Partial<OrderTerm> = {}): OrderTerm => ({
	asText: false,
	descending: false,
	field,
	nullsFirst: false,
	...extra,
})
const sorted = (order: OrderTerm[], collation: "binary" | "insensitive" = "binary") =>
	[...ROWS].sort(compareRows(order, collation)).map((row) => row.id)

describe("compareRows", () => {
	it("orders by each key in turn, descending reversing it", () => {
		expect(sorted([key("n")])).toEqual(["b", "a", "c"])
		expect(sorted([key("n", { descending: true })])).toEqual(["a", "b", "c"])
		expect(sorted([key("n", { asText: true })])).toEqual(["a", "b", "c"])
	})

	it("places nulls where the key says, and leaves rows tied on every key in input order", () => {
		expect(sorted([key("n", { nullsFirst: true })])).toEqual(["c", "b", "a"])
		expect(sorted([key("note"), key("id", { descending: true })])).toEqual(["b", "c", "a"])
		expect(compareRows([key("note")], "binary")({ note: null }, {})).toBe(0)
		expect(compareRows([], "binary")({ a: 1 }, { a: 2 })).toBe(0)
	})

	it("folds case for text under an insensitive collation, and only for text", () => {
		expect(sorted([key("name")])).toEqual(["b", "c", "a"])
		expect(sorted([key("name"), key("id", { descending: true })], "insensitive")).toEqual(["c", "b", "a"])
		expect(sorted([key("n")], "insensitive")).toEqual(["b", "a", "c"])
	})
})
