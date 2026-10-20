import { describe, expect, it } from "vitest"
import { claimsToken } from "./jwt.ts"

describe("claimsToken", () => {
	it("takes a bare scope key from the scope, and anything else as a body path", () => {
		const body = { access_token: "from-body", nested: { token: "deep" } }
		expect(claimsToken("credential", body, { credential: "bound" })).toBe("bound")
		expect(claimsToken("access_token", body, {})).toBe("from-body")
		expect(claimsToken("$.access_token", body, { "$.access_token": "never" })).toBe("from-body")
		expect(claimsToken("nested.token", body, { "nested.token": "never" })).toBe("deep")
	})
})
