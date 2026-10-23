import { describe, expect, it } from "vitest"
import { SIGN_IN } from "./sign-in.ts"

describe("SIGN_IN", () => {
	it("names a login, a token mint or a session, and nothing else", () => {
		expect(["/auth/login", "/oauth/token", "/v1/sessions", "auth.Login"].map((name) => SIGN_IN.test(name))).toEqual([
			true,
			true,
			true,
			true,
		])
		expect(SIGN_IN.test("/users")).toBe(false)
	})
})
