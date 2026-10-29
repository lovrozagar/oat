import { describe, expect, it } from "vitest"
import { FRESHNESS_DEFECTS } from "./freshness.ts"

describe("FRESHNESS_DEFECTS", () => {
	it("holds the cached-reads family: staleness past the bound, then an ignored bypass", () => {
		expect(Object.keys(FRESHNESS_DEFECTS)).toEqual(["STALE_PAST_BOUND", "BYPASS_IGNORED"])
	})

	it("names each defect in upper snake case and describes it in one clause", () => {
		for (const [name, description] of Object.entries(FRESHNESS_DEFECTS)) {
			expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
			expect(description.trim()).toBe(description)
			expect(description).not.toMatch(/\.$/)
		}
	})
})
