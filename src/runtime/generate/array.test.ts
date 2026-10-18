import { describe, expect, it } from "vitest"
import { arrayFor } from "./array.ts"
import { instance } from "./instance.ts"
import type { Context } from "./types.ts"

const noRandomness = (): number => {
	throw new TypeError("no randomness")
}

const ctx = (fields: Partial<Context> = {}): Context => ({
	defs: {},
	depth: 0,
	distinct: new Set(),
	index: 0,
	nonce: "n0",
	optional: "all",
	rand: () => 0.5,
	refs: [],
	variant: "baseline",
	...fields,
})

describe("arrayFor", () => {
	it("refuses item bounds that cross", () => {
		expect(() => arrayFor({ maxItems: 1, minItems: 2 }, ctx(), "/a", instance)).toThrow("minItems 2 exceeds maxItems 1")
	})

	it("makes one element where it can, and as many as the minimum asks", () => {
		expect(arrayFor({ items: { type: "integer" } }, ctx(), "/a", instance)).toEqual([1])
		expect(arrayFor({ items: { type: "integer" }, minItems: 3 }, ctx(), "/a", instance)).toEqual([1, 2, 5])
		expect(arrayFor({}, ctx(), "/a", instance)).toEqual(["Quarterly Report 0"])
		expect(arrayFor({ maxItems: 0 }, ctx(), "/a", instance)).toEqual([])
	})

	it("fills the prefix first, and stops there when items are forbidden or enough", () => {
		const prefixItems = [{ const: "a" }, { const: "b" }]
		expect(arrayFor({ items: false, prefixItems }, ctx(), "/a", instance)).toEqual(["a", "b"])
		expect(arrayFor({ prefixItems }, ctx(), "/a", instance)).toEqual(["a", "b"])
		expect(arrayFor({ items: { const: "c" }, minItems: 3, prefixItems }, ctx(), "/a", instance)).toEqual([
			"a",
			"b",
			"c",
		])
	})

	it("skips a repeat under uniqueItems, and refuses when too few distinct items exist", () => {
		expect(arrayFor({ items: { enum: ["x", "y"] }, minItems: 2, uniqueItems: true }, ctx(), "/a", instance)).toEqual([
			"x",
			"y",
		])
		expect(() => arrayFor({ items: { const: "x" }, minItems: 2, uniqueItems: true }, ctx(), "/a", instance)).toThrow(
			"cannot make 2 distinct items",
		)
	})

	it("stops short once the minimum is met, and refuses below it", () => {
		expect(arrayFor({ items: { type: "nonsense" } }, ctx(), "/a", instance)).toEqual([])
		expect(() => arrayFor({ items: { type: "nonsense" }, minItems: 1 }, ctx(), "/a", instance)).toThrow(
			'unknown type "nonsense"',
		)
	})

	it("lets an error that is not about the schema through", () => {
		expect(() => arrayFor({ items: { type: "number" } }, ctx({ rand: noRandomness }), "/a", instance)).toThrow(
			TypeError,
		)
	})
})
