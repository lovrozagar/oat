import { describe, expect, it } from "vitest"
import { compareScalar, equal, isNull } from "./scalar.ts"

describe("isNull", () => {
	it("holds for null and a missing value only", () => {
		expect([null, undefined, 0, "", false].map(isNull)).toEqual([true, true, false, false, false])
	})
})

describe("compareScalar", () => {
	it("compares numbers and booleans by value, everything else by its text", () => {
		expect(compareScalar(10, 9, false)).toBe(1)
		expect(compareScalar(false, true, false)).toBe(-1)
		expect(compareScalar("b", "a", false)).toBe(1)
		expect(compareScalar(2, "10", false)).toBe(1)
		expect(compareScalar("x", "x", false)).toBe(0)
	})

	it("compares even numbers by their text when asked", () => {
		expect(compareScalar(10, 9, true)).toBe(-1)
		expect(compareScalar(true, false, true)).toBe(1)
	})
})

describe("equal", () => {
	it("is strict equality, or equal text when asked", () => {
		expect(equal(2, 2, false)).toBe(true)
		expect(equal("2", 2, false)).toBe(false)
		expect(equal("2", 2, true)).toBe(true)
	})
})
