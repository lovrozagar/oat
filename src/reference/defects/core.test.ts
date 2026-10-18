import { describe, expect, it } from "vitest"
import { CORE_DEFECTS } from "./core.ts"

describe("CORE_DEFECTS", () => {
	it("holds the family of sessions, listings, writes and tenancy, in the table's order", () => {
		const names = Object.keys(CORE_DEFECTS)
		expect(names.slice(0, 3)).toEqual(["DISPOSABLE_KILLS_CALLER", "ROOT_READ_OPEN", "UNSTABLE_SORT"])
		expect(names.at(-1)).toBe("LIST_DETAIL_DISAGREE")
	})

	it("names each defect in upper snake case and describes it in one clause", () => {
		for (const [name, description] of Object.entries(CORE_DEFECTS)) {
			expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
			expect(description.trim()).toBe(description)
			expect(description.length).toBeGreaterThan(10)
			expect(description).not.toMatch(/\.$/)
		}
	})
})
