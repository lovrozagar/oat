import { describe, expect, it } from "vitest"
import { mail } from "./out-of-band.ts"
import { RequestBuilder } from "./request.ts"
import { scenario, unchecked } from "./scenario.ts"

describe("scenario", () => {
	it("turns each builder into its step and keeps plain steps, in order", () => {
		const signUp = { anonymous: true, operationId: "auth.registerWithEmail" } as const
		const built = scenario({
			covers: ["auth.deleteAccount"],
			id: "reauth",
			steps: [signUp, new RequestBuilder({ operationId: "auth.deleteAccount" }), mail("otp", "{address}").as("code")],
		})
		expect(built).toStrictEqual({
			covers: ["auth.deleteAccount"],
			id: "reauth",
			steps: [
				signUp,
				{ operationId: "auth.deleteAccount" },
				{ outOfBand: { address: "{address}", as: "code", kind: "otp" } },
			],
		})
	})

	it("copies the principal and the origin only when given", () => {
		const built = scenario({ covers: [], id: "cdn-files", origin: "cdn", principal: "admin", steps: [] })
		expect(built).toStrictEqual({ covers: [], id: "cdn-files", origin: "cdn", principal: "admin", steps: [] })
		expect(Object.keys(scenario({ covers: [], id: "x", steps: [] }))).toEqual(["covers", "id", "steps"])
	})
})

describe("unchecked", () => {
	it("is the value itself, so the step sends it as written", () => {
		const body = { amount: "not-a-number" }
		expect(unchecked(body)).toBe(body)
	})
})
