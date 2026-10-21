import { describe, expect, it } from "vitest"
import { optInFor } from "./opt-in.ts"

describe("optInFor", () => {
	it("switches nothing on for a run with no defect", () => {
		expect(optInFor([])).toEqual({ reference: {}, run: {} })
	})

	it("switches nothing on for a defect that shows without help", () => {
		expect(optInFor(["STALE_LIST"])).toEqual({ reference: {}, run: {} })
	})

	it("turns the reference's throttle on, and oat's login-throttled check, for an unthrottled login", () => {
		expect(optInFor(["LOGIN_NOT_THROTTLED"])).toEqual({
			reference: { throttleLogins: true },
			run: { checks: { "auth.login-throttled": true } },
		})
	})

	it("keeps a defect's opt-in when another defect is injected beside it", () => {
		expect(optInFor(["STALE_LIST", "LOGIN_NOT_THROTTLED"]).reference).toEqual({ throttleLogins: true })
	})
})
