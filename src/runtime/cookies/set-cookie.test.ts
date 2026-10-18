import { describe, expect, it } from "vitest"
import {
	cookiesFromRecordedHeaders,
	cookieValue,
	mergeCookieHeader,
	omitHeader,
	parseSetCookie,
	recordResponseHeaders,
	setCookieHeadersFrom,
} from "./set-cookie.ts"

const headersLike = (shape: object): Headers => shape as unknown as Headers
const combined = (name: string): string | null => (name === "set-cookie" ? "session=a" : null)

describe("parseSetCookie", () => {
	it("parses name=value and quoted values, and rejects junk", () => {
		expect(parseSetCookie("session=abc; Path=/; HttpOnly")).toEqual({ name: "session", value: "abc" })
		expect(parseSetCookie('refresh="tok=eq"; Secure')).toEqual({ name: "refresh", value: "tok=eq" })
		expect(parseSetCookie('lone="')).toEqual({ name: "lone", value: '"' })
		expect(parseSetCookie('half="x')).toEqual({ name: "half", value: '"x' })
		expect(parseSetCookie("session=")).toEqual({ name: "session", value: "" })
		expect(parseSetCookie("=novalue")).toBeNull()
		expect(parseSetCookie("HttpOnly")).toBeNull()
		expect(parseSetCookie("")).toBeNull()
		expect(parseSetCookie("  =x")).toBeNull()
	})
})

describe("setCookieHeadersFrom / recordResponseHeaders", () => {
	it("prefers getSetCookie and falls back to get", () => {
		const both = headersLike({ get: () => null, getSetCookie: () => ["session=a", "refresh=b"] })
		expect(setCookieHeadersFrom(both)).toEqual(["session=a", "refresh=b"])
		expect(setCookieHeadersFrom(headersLike({ get: combined, getSetCookie: () => [] }))).toEqual(["session=a"])
		expect(setCookieHeadersFrom(headersLike({ get: combined }))).toEqual(["session=a"])
		expect(setCookieHeadersFrom(headersLike({ get: () => null, getSetCookie: () => [] }))).toEqual([])
		expect(setCookieHeadersFrom(headersLike({ get: () => "" }))).toEqual([])
	})

	it("records every header, with the Set-Cookie lines joined by newlines", () => {
		const listed = recordResponseHeaders(
			headersLike({
				entries: () => [["content-type", "text/plain"]].values(),
				get: () => null,
				getSetCookie: () => ["session=a", "refresh=b"],
			}),
		)
		expect(listed).toEqual({ "content-type": "text/plain", "set-cookie": "session=a\nrefresh=b" })
		const none = recordResponseHeaders(new Headers({ "content-type": "text/plain" }))
		expect(none).toEqual({ "content-type": "text/plain" })
	})
})

describe("cookie lookup", () => {
	it("reads the cookies a response set, the last non-empty value of each", () => {
		expect(cookiesFromRecordedHeaders({})).toEqual({})
		expect(cookiesFromRecordedHeaders({ "set-cookie": "" })).toEqual({})
		expect(cookiesFromRecordedHeaders({ "Set-Cookie": "session=a\nHttpOnly\nrefresh=\nrefresh=b" })).toEqual({
			refresh: "b",
			session: "a",
		})
	})

	it("finds a cookie in the jar, then in recorded headers, by exact name and then by any case", () => {
		expect(cookieValue("session", { session: "a" })).toBe("a")
		expect(cookieValue("SESSION", { session: "a" })).toBe("a")
		expect(cookieValue("session", { session: "" })).toBeUndefined()
		expect(cookieValue("missing", { other: "x" })).toBeUndefined()
		expect(cookieValue("session", {}, { "set-cookie": "session=from-header" })).toBe("from-header")
		expect(cookieValue("SESSION", {}, { "set-cookie": "session=from-header" })).toBe("from-header")
		expect(cookieValue("missing", {}, { "set-cookie": "session=from-header" })).toBeUndefined()
		expect(cookieValue("session", { session: "" }, { "set-cookie": "session=" })).toBeUndefined()
	})
})

describe("the Cookie header", () => {
	it("merges the caller's cookie with the jar's", () => {
		expect(mergeCookieHeader(undefined, undefined)).toBeUndefined()
		expect(mergeCookieHeader("", "a=1")).toBe("a=1")
		expect(mergeCookieHeader(undefined, "a=1")).toBe("a=1")
		expect(mergeCookieHeader("a=1", "")).toBe("a=1")
		expect(mergeCookieHeader("a=1", undefined)).toBe("a=1")
		expect(mergeCookieHeader("a=1", "b=2")).toBe("a=1; b=2")
	})

	it("omits a header whatever its case", () => {
		const headers = { Cookie: "a=1", other: "x" }
		omitHeader(headers, "cookie")
		expect(headers).toEqual({ other: "x" })
		omitHeader(headers, "missing")
		expect(headers).toEqual({ other: "x" })
	})
})
