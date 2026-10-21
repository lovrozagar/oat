import { describe, expect, it } from "vitest"
import { DOCUMENTATION_JUDGES, isProbeExchange, judges } from "./probe-judging.ts"

/* A probe is deliberately abnormal: documentation judges leave its answer to the security checks. */

describe("isProbeExchange", () => {
	it("is a request sent as a probe, or with a forged credential", () => {
		expect([isProbeExchange({ probe: true }), isProbeExchange({ forged: true }), isProbeExchange({})]).toEqual([
			true,
			true,
			false,
		])
	})
})

describe("judges", () => {
	it("leaves a probe to every documentation judge, and to no other", () => {
		for (const judge of DOCUMENTATION_JUDGES) {
			expect([judges(judge, { probe: true }), judges(judge, {})]).toEqual([false, true])
		}
		expect(judges("response.no-server-error", { forged: true })).toBe(true)
	})
})
