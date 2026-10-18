import { describe, expect, it } from "vitest"
import { isPlanLimitResponse } from "./plan-limit.ts"

describe("isPlanLimitResponse", () => {
	it("knows a plan-limit refusal by status or by a named error", () => {
		expect(isPlanLimitResponse(402, null)).toBe(true)
		expect(isPlanLimitResponse(403, { error: "payment_required" })).toBe(true)
		expect(isPlanLimitResponse(403, { error: "forbidden" })).toBe(false)
		expect(isPlanLimitResponse(429, { error: "payment_required" })).toBe(false)
		expect(isPlanLimitResponse(200, null)).toBe(false)
		expect(isPlanLimitResponse(500, { error: "payment_required" })).toBe(false)
	})

	it("reads the error under any of its usual keys, or under vars", () => {
		expect(isPlanLimitResponse(400, { code: "PLAN_LIMIT" })).toBe(true)
		expect(isPlanLimitResponse(400, { reason: "tables_plan_limit_reached" })).toBe(true)
		expect(isPlanLimitResponse(400, { error: 3, vars: { type: "plan_limit" } })).toBe(true)
		expect(isPlanLimitResponse(400, { vars: null })).toBe(false)
		expect(isPlanLimitResponse(400, { vars: { code: "nope" } })).toBe(false)
		expect(isPlanLimitResponse(400, "plan_limit")).toBe(false)
		expect(isPlanLimitResponse(400, null)).toBe(false)
	})
})
