import { describe, expect, it } from "vitest"
import { modelFixtures } from "./models.ts"

describe("modelFixtures", () => {
	it("each declares paths and says why it is hostile", () => {
		const fixtures = modelFixtures()
		expect(fixtures).toHaveLength(9)
		for (const fixture of fixtures) {
			expect(fixture.why).not.toBe("")
			expect(Object.keys(fixture.doc["paths"] as object).length).toBeGreaterThan(0)
		}
	})
})
