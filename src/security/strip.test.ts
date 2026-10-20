import { describe, expect, it } from "vitest"
import { credentialHeaderNames, stripCredentials, stripQuery } from "./strip.ts"

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

	it("drops placed query parameters from a URL, in place, and nothing else", () => {
		const url = new URL("https://elsewhere.test/cb?key=k&q=1&key=k2")
		stripQuery(url, new Set(["key"]))
		expect(url.toString()).toBe("https://elsewhere.test/cb?q=1")
		const untouched = new URL("https://elsewhere.test/cb?q=1")
		stripQuery(untouched, new Set())
		expect(untouched.toString()).toBe("https://elsewhere.test/cb?q=1")
	})
})
