import { describe, expect, it } from "vitest"
import { RequestBuilder } from "./request.ts"

const call = (): RequestBuilder<string> => new RequestBuilder({ operationId: "auth.reauthenticate" })

/* Every own key of every object in `value`, deep, whose value is undefined. */
function undefinedKeys(value: unknown, at = "$"): string[] {
	if (value === null || typeof value !== "object") return []
	return Object.entries(value).flatMap(([key, child]) =>
		child === undefined ? [`${at}.${key}`] : undefinedKeys(child, `${at}.${key}`),
	)
}

describe("RequestBuilder", () => {
	it("emits the call alone when nothing is chained", () => {
		expect(call().toStep()).toStrictEqual({ operationId: "auth.reauthenticate" })
	})

	it("writes each chained part under the key the step type names", () => {
		const step = call()
			.save({ rotated: "$.access_token" })
			.claims("credential", { orgId: "orgs.0.oid" })
			.status(200, 201, 409)
			.poll("60s", 15_000)
			.scheme("apiKey")
			.toStep()
		expect(step).toStrictEqual({
			expect: [200, 201, 409],
			operationId: "auth.reauthenticate",
			poll: { everyMs: 15_000, within: "60s" },
			saveAs: { rotated: "$.access_token" },
			saveClaimsFrom: { bind: { orgId: "orgs.0.oid" }, token: "credential" },
			scheme: "apiKey",
		})
	})

	it("leaves everyMs out of a poll that gives none", () => {
		expect(call().poll("30s").toStep()).toStrictEqual({ operationId: "auth.reauthenticate", poll: { within: "30s" } })
	})

	it("merges saves, later names winning", () => {
		const step = call().save({ a: "$.a", b: "$.b" }).save({ b: "$.c" }).toStep()
		expect(step).toStrictEqual({ operationId: "auth.reauthenticate", saveAs: { a: "$.a", b: "$.c" } })
	})
})

describe("RequestBuilder asserts", () => {
	it("writes one assert as an object and several as an array, in order", () => {
		expect(call().equals("$.plan", "pro").toStep()).toStrictEqual({
			assert: { equals: "pro", from: "$.plan" },
			operationId: "auth.reauthenticate",
		})
		const step = call()
			.equals("$.a", "1")
			.contains("$.b", "2")
			.excludes("$.c", "3")
			.omits("$", '"token":')
			.atLeast("$.n", 4)
			.toStep()
		expect(step.assert).toStrictEqual([
			{ equals: "1", from: "$.a" },
			{ contains: "2", from: "$.b" },
			{ excludes: "3", from: "$.c" },
			{ from: "$", omits: '"token":' },
			{ atLeast: 4, from: "$.n" },
		])
	})

	it("attaches observes to the assert just before it, adding to what it already observes", () => {
		const step = call()
			.equals("$.a", "1")
			.observes("billing.checkout")
			.contains("$.b", "2")
			.observes("org.delete")
			.observes("auth.logout")
			.toStep()
		expect(step.assert).toStrictEqual([
			{ equals: "1", from: "$.a", observes: ["billing.checkout"] },
			{ contains: "2", from: "$.b", observes: ["org.delete", "auth.logout"] },
		])
	})

	it("writes an empty observes list when called with none", () => {
		const step = call().atLeast("$.reauthenticated_until", 1_700_000_000_000).observes().toStep()
		expect(step.assert).toStrictEqual({ atLeast: 1_700_000_000_000, from: "$.reauthenticated_until", observes: [] })
	})

	it("refuses observes with no assert before it", () => {
		expect(() => call().observes("auth.logout")).toThrow(
			"observes() names what an assert proves: call it after equals, contains, excludes, omits or atLeast",
		)
	})
})

describe("RequestBuilder output", () => {
	it("never changes a builder a chain branched from", () => {
		const base = call().save({ a: "$.a" }).equals("$.x", "1")
		const left = base.save({ b: "$.b" }).observes("org.delete")
		expect(base.toStep()).toStrictEqual({
			assert: { equals: "1", from: "$.x" },
			operationId: "auth.reauthenticate",
			saveAs: { a: "$.a" },
		})
		expect(left.toStep()).toStrictEqual({
			assert: { equals: "1", from: "$.x", observes: ["org.delete"] },
			operationId: "auth.reauthenticate",
			saveAs: { a: "$.a", b: "$.b" },
		})
	})

	it("holds no own undefined key anywhere in what it emits", () => {
		const step = call().save({ a: "$.a" }).equals("$.a", "1").observes().poll("1s").status(200).toStep()
		expect(undefinedKeys(step)).toEqual([])
	})
})
