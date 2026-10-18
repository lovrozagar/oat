import { describe, expect, it } from "vitest"
import { jwtOf } from "./__fixtures__/jwt.ts"
import { jwtClaims } from "./jwt.ts"

describe("jwtClaims", () => {
	it("decodes the payload without verifying the signature", () => {
		expect(jwtClaims(jwtOf({ exp: 10, org_id: "o1" }))).toEqual({ exp: 10, org_id: "o1" })
	})

	it("is null for a value that is not a JWT or whose payload is not a JSON object", () => {
		const notJson = `a.${Buffer.from("{oops").toString("base64url")}.c`
		const array = `a.${Buffer.from("[1]").toString("base64url")}.c`
		expect([jwtClaims("opaque"), jwtClaims("a.b"), jwtClaims(notJson), jwtClaims(array)]).toEqual([
			null,
			null,
			null,
			null,
		])
	})
})
