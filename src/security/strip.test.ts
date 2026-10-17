import { describe, expect, it } from "vitest"
import { credentialHeaderNames, stripCredentials } from "./strip.ts"

describe("redirect stripping", () => {
	it("drops the known credential headers and a principal's own, any case, and nothing else", () => {
		const names = credentialHeaderNames(["X-Tenant-Key"])
		const headers = { Authorization: "Bearer t", "x-tenant-key": "k", cookie: "s=1", accept: "json" }
		stripCredentials(headers, names)
		expect(headers).toEqual({ accept: "json" })
	})

	it("knows the built-in names without any injected one", () => {
		expect(credentialHeaderNames().has("proxy-authorization")).toBe(true)
	})
})
