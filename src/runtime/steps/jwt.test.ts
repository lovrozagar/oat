import { describe, expect, it } from "vitest"
import { jwt } from "../scenario/__fixtures__/stage.ts"
import { claimsToken, jwtExpiryMs } from "./jwt.ts"

describe("jwtExpiryMs", () => {
	it("reads `exp` in milliseconds, or null without a numeric one", () => {
		expect(jwtExpiryMs(jwt({ exp: 10 }))).toBe(10_000)
		expect(jwtExpiryMs(jwt({ exp: "10" }))).toBeNull()
		expect(jwtExpiryMs("opaque")).toBeNull()
	})
})

describe("claimsToken", () => {
	it("takes a bare scope key from the scope, and anything else as a body path", () => {
		const body = { access_token: "from-body", nested: { token: "deep" } }
		expect(claimsToken("credential", body, { credential: "bound" })).toBe("bound")
		expect(claimsToken("access_token", body, {})).toBe("from-body")
		expect(claimsToken("$.access_token", body, { "$.access_token": "never" })).toBe("from-body")
		expect(claimsToken("nested.token", body, { "nested.token": "never" })).toBe("deep")
	})
})
