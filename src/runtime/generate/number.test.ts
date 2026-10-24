import { describe, expect, it } from "vitest"
import { nonceNumber } from "./nonce.ts"
import { numberFor } from "./number.ts"
import type { At, Context } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"

const refusal = (integer: boolean): unknown => {
	try {
		return numberFor({ maximum: 1, minimum: 5 }, at(), integer)
	} catch (error) {
		return error instanceof Unconstructible ? `${error.pointer} ${error.reason}` : error
	}
}

const at = (fields: Partial<Context> = {}, distinct = false): At => ({
	ctx: {
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
	},
	distinct,
	pointer: "/n",
})

describe("numberFor", () => {
	it("climbs a ladder whose text order is not its number order", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map((index) => numberFor({}, at({ index }), true))).toEqual([
			1, 2, 5, 10, 20, 50, 100, 1,
		])
	})

	it("adds a fraction to a number, from the generator's randomness", () => {
		expect(numberFor({}, at({ rand: () => 0.3 }), false)).toBe(1.3)
	})

	it("starts at the minimum and keeps to the step", () => {
		expect(numberFor({ minimum: 10 }, at(), true)).toBe(11)
		expect(numberFor({ minimum: 3, multipleOf: 7 }, at(), true)).toBe(7)
		expect(numberFor({ maximum: 1, minimum: 0, multipleOf: 0.25 }, at(), false)).toBe(1)
	})

	it("honors exclusive bounds", () => {
		expect(numberFor({ exclusiveMaximum: 5, exclusiveMinimum: 0 }, at({ index: 5 }), true)).toBe(1)
		expect(numberFor({ exclusiveMaximum: 1, exclusiveMinimum: 0 }, at(), false)).toBe(0.5)
	})

	it("sits on a bound at the boundary variant", () => {
		expect(numberFor({ maximum: 9, minimum: 2 }, at({ variant: "boundary" }), true)).toBe(9)
		expect(numberFor({ minimum: 2 }, at({ variant: "boundary" }), true)).toBe(2)
		expect(numberFor({}, at({ variant: "boundary" }), true)).toBe(1)
	})

	it("moves a distinct value by the nonce", () => {
		expect(numberFor({}, at({}, true), true)).toBe(1 + (nonceNumber("n0") % 997))
		expect(numberFor({}, at({ nonce: undefined }, true), true)).toBe(1)
	})

	it("falls back to the first rung for an index outside the ladder", () => {
		expect(numberFor({}, at({ index: -1 }), true)).toBe(1)
	})

	it("refuses bounds nothing satisfies", () => {
		expect(refusal(true)).toBe("/n no integer satisfies the bounds")
		expect(refusal(false)).toBe("/n no number satisfies the bounds")
	})
})
