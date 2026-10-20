import { describe, expect, it } from "vitest"
import { capturedBy, unfilledIn } from "./placeholders.ts"

const token = {
	body: { key: "{principal.key}" },
	operationId: "auth.token",
	saveAs: { refresh_token: "$.refresh_token" },
}
const renew = { body: { refresh_token: "{refresh_token}" }, operationId: "auth.refresh" }

describe("unfilledIn", () => {
	it("fills a name from what the chain started with, or what an earlier step bound", () => {
		expect(unfilledIn([token, renew], [])).toBeUndefined()
		expect(unfilledIn([renew], ["refresh_token"])).toBeUndefined()
		const otp = { outOfBand: { address: "{email}", as: "code", kind: "otp" } }
		const verify = { body: { code: "{code}" }, method: "POST", path: "/verify/{code}", saveClaimsFrom: { bind: {} } }
		const claims = { operationId: "me", saveClaimsFrom: { bind: { org: "org_id" }, token: "$.t" } }
		expect(
			unfilledIn([otp, verify, claims, { operationId: "orgs", query: { org: "{org}" } }], ["email"]),
		).toBeUndefined()
	})

	it("names the first placeholder nothing before it fills, and its step", () => {
		expect(unfilledIn([renew], ["access_token", "credential"])).toEqual({ name: "refresh_token", step: 1 })
		const late = { headers: { "x-id": "{session}" }, operationId: "auth.me", saveAs: { session: "$.id" } }
		expect(unfilledIn([token, late], [])).toEqual({ name: "session", step: 2 })
		expect(unfilledIn([{ method: "GET", path: "/hop/{hop}" }], [])).toEqual({ name: "hop", step: 1 })
		expect(unfilledIn([{ outOfBand: { address: "{inbox}", as: "code", kind: "otp" } }], [])).toEqual({
			name: "inbox",
			step: 1,
		})
	})

	it("reads a step's binds in order, before its request, and its saveAs addresses after", () => {
		const bound = { bind: { a: "x", b: "{a}-{c}" }, operationId: "auth.token" }
		expect(unfilledIn([bound], ["c"])).toBeUndefined()
		expect(unfilledIn([bound], [])).toEqual({ name: "c", step: 1 })
		const saved = { operationId: "auth.token", saveAs: { kind: "$.kind", value: "$.{kind}" } }
		expect(unfilledIn([saved], [])).toBeUndefined()
		expect(unfilledIn([{ operationId: "auth.token", saveAs: { value: "$.{kind}" } }], [])).toEqual({
			name: "kind",
			step: 1,
		})
	})

	it("leaves an operation's own path to the document, and reads no shape it does not know", () => {
		expect(unfilledIn([{ operationId: "auth.token", path: "/{ignored}" }, null, "step", 3], [])).toBeUndefined()
		expect(unfilledIn([{ bind: "{a}", body: [{ deep: ["{b}"] }], operationId: "x" }], ["b"])).toBeUndefined()
	})
})

describe("capturedBy", () => {
	it("is every name a chain binds", () => {
		const otp = { outOfBand: { address: "{email}", as: "code", kind: "otp" } }
		const claims = { bind: { a: "1" }, operationId: "me", saveClaimsFrom: { bind: { org: "org_id" }, token: "$.t" } }
		expect([...capturedBy([token, otp, claims, null])].sort()).toEqual(["a", "code", "org", "refresh_token"])
	})
})
