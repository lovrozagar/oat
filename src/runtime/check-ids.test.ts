import { describe, expect, it } from "vitest"
import { CHECK_IDS, familyOf, FAMILY_OF_PREFIX, RUN_FINDING_IDS } from "./check-ids.ts"

describe("check ids", () => {
	it("are unique, and none is also a run finding id", () => {
		expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length)
		const checks = new Set<string>(CHECK_IDS)
		expect(RUN_FINDING_IDS.filter((id) => checks.has(id))).toEqual([])
	})

	it("each belongs to the family of its prefix", () => {
		expect(familyOf("filter.empty-in")).toBe(FAMILY_OF_PREFIX.filter)
		for (const id of CHECK_IDS) expect(Object.values(FAMILY_OF_PREFIX)).toContain(familyOf(id))
	})
})
