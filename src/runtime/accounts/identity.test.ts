import { describe, expect, it } from "vitest"
import { accountIdentity, accountLabel, identityNames } from "./identity.ts"

/* An account is named by what it signs in or is found by, never by what it signs in with. */

describe("accountIdentity", () => {
	it("keeps the naming strings a sign-up sent, under each convention, and nothing else", () => {
		const body = {
			address: "d@x.test",
			email: "a@x.test",
			emailAddress: "b@x.test",
			"e-mail": "c@x.test",
			handle: "h",
			login: "l",
			nickname: "n",
			password: "secret",
			phone_number: "+1",
			tenant: "t",
			user_name: "u",
			username: "",
		}
		expect(accountIdentity(body)).toEqual({
			address: "d@x.test",
			email: "a@x.test",
			emailAddress: "b@x.test",
			"e-mail": "c@x.test",
			handle: "h",
			login: "l",
			nickname: "n",
			phone_number: "+1",
			user_name: "u",
		})
	})

	it("is empty for a body that is no object", () => {
		for (const body of [null, "x", ["email"], undefined]) expect(accountIdentity(body)).toEqual({})
	})
})

describe("identityNames", () => {
	it("names a schema's top-level properties that name an account", () => {
		const schema = { properties: { email: {}, password: {}, username: {} }, type: "object" }
		expect(identityNames(schema)).toEqual(["email", "username"])
	})

	it("is empty for a schema with no properties", () => {
		for (const schema of [null, true, {}, { properties: null }]) expect(identityNames(schema)).toEqual([])
	})
})

describe("accountLabel", () => {
	it("names an account by its email, else its first naming value, else nothing", () => {
		expect(accountLabel({ email: "a@x.test", username: "u" })).toBe("a@x.test")
		expect(accountLabel({ address: "a@x.test", username: "u" })).toBe("a@x.test")
		expect(accountLabel({ username: "u" })).toBe("u")
		expect(accountLabel({})).toBeUndefined()
	})
})
