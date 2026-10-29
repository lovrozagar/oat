import { describe, expect, it } from "vitest"
import { blockedCheckOf, blockedCheckSummary } from "./blocked-check.ts"

describe("blockedCheckOf", () => {
	it("reads back the check a blocked summary names", () => {
		const summary = blockedCheckSummary("auth.privileged-field-ignored")
		expect(summary).toBe("auth.privileged-field-ignored needed a credential that is BLOCKED")
		expect(blockedCheckOf({ check: "auth.blocked", summary })).toBe("auth.privileged-field-ignored")
	})

	it("reads nothing from another finding, or from an auth.blocked one about something else", () => {
		expect(blockedCheckOf({ check: "list.read-after-write", summary: blockedCheckSummary("x") })).toBeUndefined()
		expect(blockedCheckOf({ check: "auth.blocked", summary: "auth.login failed for alpha" })).toBeUndefined()
	})
})
