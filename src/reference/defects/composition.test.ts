import { describe, expect, it } from "vitest"
import { COMPOSITION_DEFECTS } from "./composition.ts"

describe("COMPOSITION_DEFECTS", () => {
	it("holds the family of axes that break once combined, in the table's order", () => {
		const names = Object.keys(COMPOSITION_DEFECTS)
		expect(names.slice(0, 3)).toEqual([
			"FILTER_DROPPED_WHEN_SORTED",
			"FILTER_DROPPED_WHEN_SELECTED",
			"FILTER_DROPPED_WHEN_SEARCHED",
		])
		expect(names.at(-1)).toBe("FILTER_AFTER_PAGINATION")
	})

	it("names each defect in upper snake case and describes it in one clause", () => {
		for (const [name, description] of Object.entries(COMPOSITION_DEFECTS)) {
			expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
			expect(description.trim()).toBe(description)
			expect(description.length).toBeGreaterThan(10)
			expect(description).not.toMatch(/\.$/)
		}
	})
})
