import { describe, expect, it } from "vitest"
import { nextCursorOf } from "./cursor.ts"

describe("nextCursorOf", () => {
	it("keeps a cursor given as text", () => {
		expect(nextCursorOf("eyJpZCI6Im4yIn0")).toBe("eyJpZCI6Im4yIn0")
	})

	it("sends a cursor given as a number as its decimal text", () => {
		expect(nextCursorOf(1793400000123)).toBe("1793400000123")
		expect(nextCursorOf(0)).toBe("0")
		expect(nextCursorOf(-1.5)).toBe("-1.5")
	})

	it("ends the walk on anything else", () => {
		for (const value of ["", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true, {}, ["2"]]) {
			expect(nextCursorOf(value)).toBeUndefined()
		}
	})
})
