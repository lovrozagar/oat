import { describe, expect, it } from "vitest"
import { CHECK_IDS, familyOf, FAMILY_OF_PREFIX, RUN_FINDING_IDS, SECURITY_CHECK_IDS } from "./check-ids.ts"

describe("check ids", () => {
	it("are unique, and none is also a run finding id", () => {
		expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length)
		const checks = new Set<string>(CHECK_IDS)
		expect(RUN_FINDING_IDS.filter((id) => checks.has(id))).toEqual([])
	})

	it("each outside the security set belongs to the family of its prefix", () => {
		expect(familyOf("filter.empty-in")).toBe(FAMILY_OF_PREFIX.filter)
		const security = new Set<string>(SECURITY_CHECK_IDS)
		for (const id of CHECK_IDS.filter((checkId) => !security.has(checkId))) {
			expect(Object.values(FAMILY_OF_PREFIX)).toContain(familyOf(id))
		}
	})
})

describe("the security family", () => {
	it("is an explicit set: its ids are check ids, each in the security family", () => {
		const checks = new Set<string>(CHECK_IDS)
		for (const id of SECURITY_CHECK_IDS) {
			expect(checks.has(id)).toBe(true)
			expect(familyOf(id)).toBe("security")
		}
	})

	it("takes an id out of its prefix's family only when the set names it", () => {
		expect(familyOf("auth.rank-is-monotonic")).toBe("isolation")
		expect(familyOf("auth.rank-is-monotonic", ["auth.rank-is-monotonic"])).toBe("security")
		expect(familyOf("auth.invite-grants-then-revokes", ["auth.rank-is-monotonic"])).toBe("isolation")
	})
})
