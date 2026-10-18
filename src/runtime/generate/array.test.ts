import { describe, expect, it } from "vitest"
import { arrayFor } from "./array.ts"
import { instance } from "./instance.ts"
import type { At, Context } from "./types.ts"

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

/* The walk standing at `/a`, not bound to be distinct. */
const at = (fields: Partial<Context> = {}): At => ({ ctx: ctx(fields), distinct: false, pointer: "/a" })

describe("arrayFor", () => {
	it("refuses item bounds that cross", () => {
		expect(() => arrayFor({ maxItems: 1, minItems: 2 }, at(), instance)).toThrow("minItems 2 exceeds maxItems 1")
	})

	it("makes one element where it can, and as many as the minimum asks", () => {
		expect(arrayFor({ items: { type: "integer" } }, at(), instance)).toEqual([1])
		expect(arrayFor({ items: { type: "integer" }, minItems: 3 }, at(), instance)).toEqual([1, 2, 5])
		expect(arrayFor({}, at(), instance)).toEqual(["Quarterly Report 0"])
		expect(arrayFor({ maxItems: 0 }, at(), instance)).toEqual([])
	})

	it("fills the prefix first, and stops there when items are forbidden or enough", () => {
		const prefixItems = [{ const: "a" }, { const: "b" }]
		expect(arrayFor({ items: false, prefixItems }, at(), instance)).toEqual(["a", "b"])
		expect(arrayFor({ prefixItems }, at(), instance)).toEqual(["a", "b"])
		expect(arrayFor({ items: { const: "c" }, minItems: 3, prefixItems }, at(), instance)).toEqual(["a", "b", "c"])
	})

	it("skips a repeat under uniqueItems, and refuses when too few distinct items exist", () => {
		expect(arrayFor({ items: { enum: ["x", "y"] }, minItems: 2, uniqueItems: true }, at(), instance)).toEqual([
			"x",
			"y",
		])
		expect(() => arrayFor({ items: { const: "x" }, minItems: 2, uniqueItems: true }, at(), instance)).toThrow(
			"cannot make 2 distinct items",
		)
	})

	it("stops short once the minimum is met, and refuses below it", () => {
		expect(arrayFor({ items: { type: "nonsense" } }, at(), instance)).toEqual([])
		expect(() => arrayFor({ items: { type: "nonsense" }, minItems: 1 }, at(), instance)).toThrow(
			'unknown type "nonsense"',
		)
	})

	it("lets an error that is not about the schema through", () => {
		expect(() => arrayFor({ items: { type: "number" } }, at({ rand: noRandomness }), instance)).toThrow(TypeError)
	})
})
