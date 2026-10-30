import { describe, expect, it } from "vitest"
import { storedAs } from "./stored-as.ts"

describe("storedAs", () => {
	it("holds a string stored trimmed or case-folded", () => {
		expect(storedAs("quarterly report 0", "Quarterly Report 0")).toBe(true)
		expect(storedAs(" a ", "a")).toBe(true)
	})

	it("refuses a string stored otherwise changed", () => {
		expect(storedAs("quarterly-report-0", "Quarterly Report 0")).toBe(false)
		expect(storedAs("", "a")).toBe(false)
	})

	it("compares every other value exactly, a numeral and its number apart", () => {
		expect(storedAs({ a: [1] }, { a: [1] })).toBe(true)
		expect(storedAs(3, 3)).toBe(true)
		expect(storedAs("3", 3)).toBe(false)
		expect(storedAs(true, "true")).toBe(false)
		expect(storedAs(undefined, "a")).toBe(false)
	})
})
