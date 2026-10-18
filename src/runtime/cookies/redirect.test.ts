import { describe, expect, it } from "vitest"
import { isAbsoluteHttpUrl, isRedirectStatus, MAX_REDIRECTS, redirectTarget } from "./redirect.ts"

const current = new URL("https://app.example.com/verify?t=1")

describe("isAbsoluteHttpUrl", () => {
	it("accepts http(s) and rejects everything else", () => {
		expect(isAbsoluteHttpUrl("https://app.example.com/verify?t=1")).toBe(true)
		expect(isAbsoluteHttpUrl("HTTP://localhost/x")).toBe(true)
		expect(isAbsoluteHttpUrl("/verify")).toBe(false)
		expect(isAbsoluteHttpUrl("ftp://x")).toBe(false)
		expect(isAbsoluteHttpUrl("httpfoo")).toBe(false)
		expect(MAX_REDIRECTS).toBe(20)
	})
})

describe("isRedirectStatus", () => {
	it("knows the five redirects and nothing else", () => {
		expect([301, 302, 303, 307, 308].every(isRedirectStatus)).toBe(true)
		expect([200, 300, 304, 399].some(isRedirectStatus)).toBe(false)
	})
})

describe("redirectTarget", () => {
	it("follows 303 as a GET, and 301/302 as a GET only for a method other than GET or HEAD", () => {
		expect(redirectTarget(303, "GET", "/app", current)).toEqual({
			dropBody: true,
			method: "GET",
			url: new URL("https://app.example.com/app"),
		})
		expect(redirectTarget(302, "POST", "/next", current)?.method).toBe("GET")
		expect(redirectTarget(302, "POST", "/next", current)?.dropBody).toBe(true)
		expect(redirectTarget(301, "GET", "/next", current)).toEqual({
			dropBody: false,
			method: "GET",
			url: new URL("https://app.example.com/next"),
		})
		expect(redirectTarget(301, "HEAD", "/next", current)?.method).toBe("HEAD")
		expect(redirectTarget(302, "GET", "/next", current)?.dropBody).toBe(false)
	})

	it("keeps the method and body through 307 and 308", () => {
		expect(redirectTarget(307, "post", "/next", current)).toEqual({
			dropBody: false,
			method: "POST",
			url: new URL("https://app.example.com/next"),
		})
		expect(redirectTarget(308, "PUT", "https://app.example.com/kept", current)).toEqual({
			dropBody: false,
			method: "PUT",
			url: new URL("https://app.example.com/kept"),
		})
	})

	it("follows nothing that is not a redirect to an http(s) URL", () => {
		expect(redirectTarget(303, "GET", null, current)).toBeNull()
		expect(redirectTarget(303, "GET", "", current)).toBeNull()
		expect(redirectTarget(200, "GET", "/app", current)).toBeNull()
		expect(redirectTarget(303, "GET", "ftp://x/y", current)).toBeNull()
		expect(redirectTarget(303, "GET", "http://[", current)).toBeNull()
		expect(redirectTarget(303, "GET", "http://plain.test/", current)?.url.href).toBe("http://plain.test/")
	})
})
