import { describe, expect, it } from "vitest"
import { QUERY_DEFECTS } from "./query.ts"

describe("QUERY_DEFECTS", () => {
	it("holds the family of what a filter, a sort or a select means, in the table's order", () => {
		const names = Object.keys(QUERY_DEFECTS)
		expect(names.slice(0, 3)).toEqual(["SPEC_OVERCLAIMS_FILTERABLE", "FILTER_IN_FIRST_ONLY", "FILTER_GTE_IS_GT"])
		expect(names.at(-1)).toBe("SPEC_OVERCLAIMS_SELECTABLE")
	})

	it("names each defect in upper snake case and describes it in one clause", () => {
		for (const [name, description] of Object.entries(QUERY_DEFECTS)) {
			expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
			expect(description.trim()).toBe(description)
			expect(description.length).toBeGreaterThan(10)
			expect(description).not.toMatch(/\.$/)
		}
	})
})
