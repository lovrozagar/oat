import { describe, expect, it } from "vitest"
import { TABLE } from "../model/table.ts"
import { ROOT_SECURITY, SECURITY_SCHEMES, securedByEntity } from "./security.ts"

describe("SECURITY_SCHEMES and ROOT_SECURITY", () => {
	it("declare a bearer JWT and an API key in Authorization, and the JWT for every operation by default", () => {
		expect(SECURITY_SCHEMES).toEqual({
			apiKey: { description: "ApiKey <key>", in: "header", name: "Authorization", type: "apiKey" },
			jwt: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
		})
		expect(ROOT_SECURITY).toEqual([{ jwt: [] }])
	})
})

describe("securedByEntity", () => {
	it("takes a JWT or an API key with the entity's read scope for a read, and its write scope otherwise", () => {
		const item = securedByEntity(TABLE, { delete: { a: 1 }, get: { b: 2 }, patch: { c: 3 } })
		expect(item).toEqual({
			delete: { a: 1, security: [{ jwt: [] }, { apiKey: ["table:write"] }] },
			get: { b: 2, security: [{ jwt: [] }, { apiKey: ["table:read"] }] },
			patch: { c: 3, security: [{ jwt: [] }, { apiKey: ["table:write"] }] },
		})
	})
})
