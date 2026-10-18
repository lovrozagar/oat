import { describe, expect, it } from "vitest"
import { estimateRequests, TYPICAL_REQUESTS } from "./check-costs.ts"
import { CHECKS } from "./checks/registry.ts"
import { entityOf, referenceModel } from "./scope/__fixtures__/models.ts"

const DEFAULT_CHECK_COST = 2

describe("estimateRequests", () => {
	const model = referenceModel()

	it("seeds a cohort for an entity it can create, and only reads one it cannot", () => {
		const row = entityOf(model, "row")
		expect(estimateRequests(row, model) - estimateRequests(row, model, 3)).toBe(4)
		const notice = entityOf(model, "notice")
		expect(estimateRequests(notice, model, 3)).toBe(estimateRequests(notice, model))
	})

	it("adds each applicable check's typical cost, and a default for a check not yet measured", () => {
		const notice = entityOf(model, "notice")
		const applicable = CHECKS.filter((check) => check.subjects(notice, model).length > 0)
		expect(applicable.some((check) => TYPICAL_REQUESTS[check.id] === undefined)).toBe(true)
		const checks = applicable.reduce((sum, check) => sum + (TYPICAL_REQUESTS[check.id] ?? DEFAULT_CHECK_COST), 0)
		expect(estimateRequests(notice, model)).toBe(1 + checks)
	})
})
