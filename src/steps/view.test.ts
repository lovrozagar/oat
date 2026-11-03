import { describe, expect, it } from "vitest"
import type { Scenario } from "../config/types/steps.ts"
import { stepsOf } from "./view.ts"

const ARM: Scenario = {
	covers: ["auth.updateNotificationPreferences", "auth.logout"],
	id: "offer-arm",
	steps: [
		{ operationId: "auth.retrieveProfile" },
		{ body: { channel: "email", marketing: false }, operationId: "auth.updateNotificationPreferences" },
		{ body: { channel: "email", marketing: true, tags: ["a"] }, operationId: "auth.updateNotificationPreferences" },
		{ operationId: "auth.logout" },
		{ outOfBand: { address: "{address}", as: "code", kind: "otp" } },
		{
			assert: [
				{ equals: "1", from: "$.a", observes: ["auth.updateNotificationPreferences"] },
				{ from: "$.b", omits: "x" },
			],
			operationId: "domain.list",
		},
		{ assert: { excludes: "s", from: "$.c", observes: ["auth.logout"] }, operationId: "auth.retrieveProfile" },
	],
}
const OTHER: Scenario = { covers: [], id: "other", steps: [] }
const all = [OTHER, ARM]

describe("stepsOf", () => {
	it("finds a call, optionally by a subset of its fields", () => {
		const arm = stepsOf(all, "offer-arm")
		expect(arm.indexOf("auth.updateNotificationPreferences")).toBe(1)
		expect(arm.indexOf("auth.updateNotificationPreferences", { body: { marketing: true } })).toBe(2)
		expect(arm.indexOf("auth.updateNotificationPreferences", { body: { tags: ["a"] } })).toBe(2)
		expect(arm.indexOf("auth.updateNotificationPreferences", { body: { tags: ["a", "b"] } })).toBe(-1)
		expect(arm.indexOf("auth.updateNotificationPreferences", { body: { tags: "a" } })).toBe(-1)
		expect(arm.indexOf("auth.updateNotificationPreferences", { body: { channel: "sms" } })).toBe(-1)
		expect(arm.indexOf("auth.updateNotificationPreferences", { body: { channel: { kind: "email" } } })).toBe(-1)
		expect(arm.indexOf("billing.checkout")).toBe(-1)
	})

	it("lists every call of an operation with its index", () => {
		const calls = stepsOf(all, "offer-arm").calls("auth.retrieveProfile")
		expect(calls.map(({ index }) => index)).toEqual([0, 6])
		expect(calls[1]?.step).toBe(ARM.steps[6])
	})

	it("flattens every assert, in step order", () => {
		expect(
			stepsOf(all, "offer-arm")
				.asserts()
				.map((assert) => assert.from),
		).toEqual(["$.a", "$.b", "$.c"])
	})
})

describe("stepsOf observes", () => {
	it("says an operation is observed only when it is covered, called, and named by a later assert", () => {
		const arm = stepsOf(all, "offer-arm")
		expect(arm.observes("auth.updateNotificationPreferences")).toBe(true)
		expect(arm.observes("auth.logout")).toBe(true)
		/* Called and covered by nothing that observes it. */
		expect(stepsOf([{ ...ARM, covers: ["auth.retrieveProfile"] }], "offer-arm").observes("auth.retrieveProfile")).toBe(
			false,
		)
		/* Observed, but not covered: a scenario grades only what it covers. */
		expect(stepsOf([{ ...ARM, covers: [] }], "offer-arm").observes("auth.logout")).toBe(false)
		/* Never called at all. */
		expect(arm.observes("domain.create")).toBe(false)
		/* An assert before the call proves nothing about it. */
		const early: Scenario = {
			covers: ["auth.logout"],
			id: "early",
			steps: [
				{ assert: { from: "$", omits: "x", observes: ["auth.logout"] }, operationId: "a.b" },
				{ operationId: "auth.logout" },
			],
		}
		expect(stepsOf([early], "early").observes("auth.logout")).toBe(false)
	})
})

describe("stepsOf lookup", () => {
	it("hands back the scenario and its steps", () => {
		const arm = stepsOf(all, "offer-arm")
		expect(arm.scenario).toBe(ARM)
		expect(arm.steps).toBe(ARM.steps)
	})

	it("names the ids it has when the one asked for is missing", () => {
		expect(() => stepsOf(all, "offer-redeem")).toThrow('no scenario "offer-redeem" among: other, offer-arm')
	})
})
