import { describe, expect, it } from "vitest"
import { CredentialCollision, UnsatisfiedSecurity } from "./credential-source.ts"

describe("the credential port's errors", () => {
	it("carries an unsatisfied or blocked reason with its kind", () => {
		const error = new UnsatisfiedSecurity("blocked", 'could not acquire the "jwt" credential for "alpha": 500')
		expect(error).toBeInstanceOf(Error)
		expect([error.name, error.kind, error.reason, error.message]).toEqual([
			"UnsatisfiedSecurity",
			"blocked",
			'could not acquire the "jwt" credential for "alpha": 500',
			'could not acquire the "jwt" credential for "alpha": 500',
		])
	})

	it("names the colliding place, name and scheme", () => {
		const error = new CredentialCollision("header", { name: "Authorization", scheme: "jwt" })
		expect([error.name, error.place, error.placed]).toEqual([
			"CredentialCollision",
			"header",
			{ name: "Authorization", scheme: "jwt" },
		])
		expect(error.message).toBe('header "Authorization" collides with the jwt credential placement')
	})
})
