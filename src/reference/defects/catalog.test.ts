import { describe, expect, it } from "vitest"
import { CATALOG_DEFECTS } from "./catalog.ts"

describe("CATALOG_DEFECTS", () => {
	it("holds the family of what the declared catalog promises, in the table's order", () => {
		const names = Object.keys(CATALOG_DEFECTS)
		expect(names.slice(0, 3)).toEqual([
			"FILTER_ALIAS_MISMAPPED",
			"FILTER_CONDITION_CAP_IGNORED",
			"FILTER_IN_CAP_IGNORED",
		])
		expect(names.at(-1)).toBe("HIDDEN_FROM_CREATOR")
	})

	it("names each defect in upper snake case and describes it in one clause", () => {
		for (const [name, description] of Object.entries(CATALOG_DEFECTS)) {
			expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
			expect(description.trim()).toBe(description)
			expect(description.length).toBeGreaterThan(10)
			expect(description).not.toMatch(/\.$/)
		}
	})
})
