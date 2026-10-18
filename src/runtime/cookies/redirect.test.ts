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
		expect(redirectTarget({ location: "/app", status: 303 }, { method: "GET", url: current })).toEqual({
			dropBody: true,
			method: "GET",
			url: new URL("https://app.example.com/app"),
		})
		expect(redirectTarget({ location: "/next", status: 302 }, { method: "POST", url: current })?.method).toBe("GET")
		expect(redirectTarget({ location: "/next", status: 302 }, { method: "POST", url: current })?.dropBody).toBe(true)
		expect(redirectTarget({ location: "/next", status: 301 }, { method: "GET", url: current })).toEqual({
			dropBody: false,
			method: "GET",
			url: new URL("https://app.example.com/next"),
		})
		expect(redirectTarget({ location: "/next", status: 301 }, { method: "HEAD", url: current })?.method).toBe("HEAD")
		expect(redirectTarget({ location: "/next", status: 302 }, { method: "GET", url: current })?.dropBody).toBe(false)
	})

	it("keeps the method and body through 307 and 308", () => {
		expect(redirectTarget({ location: "/next", status: 307 }, { method: "post", url: current })).toEqual({
			dropBody: false,
			method: "POST",
			url: new URL("https://app.example.com/next"),
		})
		expect(
			redirectTarget({ location: "https://app.example.com/kept", status: 308 }, { method: "PUT", url: current }),
		).toEqual({
			dropBody: false,
			method: "PUT",
			url: new URL("https://app.example.com/kept"),
		})
	})

	it("follows nothing that is not a redirect to an http(s) URL", () => {
		expect(redirectTarget({ location: null, status: 303 }, { method: "GET", url: current })).toBeNull()
		expect(redirectTarget({ location: "", status: 303 }, { method: "GET", url: current })).toBeNull()
		expect(redirectTarget({ location: "/app", status: 200 }, { method: "GET", url: current })).toBeNull()
		expect(redirectTarget({ location: "ftp://x/y", status: 303 }, { method: "GET", url: current })).toBeNull()
		expect(redirectTarget({ location: "http://[", status: 303 }, { method: "GET", url: current })).toBeNull()
		expect(
			redirectTarget({ location: "http://plain.test/", status: 303 }, { method: "GET", url: current })?.url.href,
		).toBe("http://plain.test/")
	})
})
