import { describe, expect, it } from "vitest"
import {
	CookieJar,
	MAX_REDIRECTS,
	applyJarToHeaders,
	cookieValue,
	cookiesFromRecordedHeaders,
	describeSaveAs,
	headerValue,
	isAbsoluteHttpUrl,
	isRedirectStatus,
	mergeCookieHeader,
	omitHeader,
	parseSetCookie,
	readSaveAs,
	recordResponseHeaders,
	redirectTarget,
	setCookieHeadersFrom,
} from "../src/runtime/cookies.ts"

function jsonPath(body: unknown, path: string): unknown {
	let node: unknown = body
	for (const segment of path
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)) {
		if (node === null || typeof node !== "object") return undefined
		node = (node as Record<string, unknown>)[segment]
	}
	return node
}

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

describe("parseSetCookie", () => {
	it("parses name=value and quoted values, and rejects junk", () => {
		expect(parseSetCookie("session=abc; Path=/; HttpOnly")).toEqual({ name: "session", value: "abc" })
		expect(parseSetCookie('refresh="tok=eq"; Secure')).toEqual({ name: "refresh", value: "tok=eq" })
		expect(parseSetCookie("session=")).toEqual({ name: "session", value: "" })
		expect(parseSetCookie("=novalue")).toBeNull()
		expect(parseSetCookie("HttpOnly")).toBeNull()
		expect(parseSetCookie("")).toBeNull()
		expect(parseSetCookie("  =x")).toBeNull()
	})
})

describe("setCookieHeadersFrom / recordResponseHeaders", () => {
	it("prefers getSetCookie and falls back to get", () => {
		expect(
			setCookieHeadersFrom({
				getSetCookie: () => ["session=a", "refresh=b"],
				get: () => null,
			} as unknown as Headers),
		).toEqual(["session=a", "refresh=b"])
		expect(
			setCookieHeadersFrom({
				getSetCookie: () => [],
				get: (name: string) => (name === "set-cookie" ? "session=a" : null),
			} as unknown as Headers),
		).toEqual(["session=a"])
		expect(
			setCookieHeadersFrom({
				get: (name: string) => (name === "set-cookie" ? "session=a" : null),
			} as unknown as Headers),
		).toEqual(["session=a"])
		expect(
			setCookieHeadersFrom({
				getSetCookie: () => [],
				get: () => null,
			} as unknown as Headers),
		).toEqual([])
		expect(
			setCookieHeadersFrom({
				get: () => "",
			} as unknown as Headers),
		).toEqual([])

		const listed = recordResponseHeaders({
			entries: () => [["content-type", "text/plain"]].values(),
			getSetCookie: () => ["session=a", "refresh=b"],
			get: () => null,
		} as unknown as Headers)
		expect(listed["content-type"]).toBe("text/plain")
		expect(listed["set-cookie"]).toBe("session=a\nrefresh=b")

		const none = recordResponseHeaders({
			entries: () => [["content-type", "text/plain"]].values(),
			getSetCookie: () => [],
			get: () => null,
		} as unknown as Headers)
		expect(none["set-cookie"]).toBeUndefined()
	})
})

describe("cookie / header lookup", () => {
	it("reads cookies from the jar and recorded headers, case-insensitively", () => {
		expect(headerValue({ "X-Foo": "bar" }, "x-foo")).toBe("bar")
		expect(headerValue({ a: "1" }, "b")).toBeUndefined()
		expect(cookiesFromRecordedHeaders({})).toEqual({})
		expect(cookiesFromRecordedHeaders({ "set-cookie": "" })).toEqual({})
		expect(cookiesFromRecordedHeaders({ "Set-Cookie": "session=a\nHttpOnly\nrefresh=\nrefresh=b" })).toEqual({
			refresh: "b",
			session: "a",
		})
		expect(cookieValue("session", { session: "a" })).toBe("a")
		expect(cookieValue("SESSION", { session: "a" })).toBe("a")
		expect(cookieValue("session", { session: "" })).toBeUndefined()
		expect(cookieValue("missing", { other: "x" })).toBeUndefined()
		expect(cookieValue("session", {}, { "set-cookie": "session=from-header" })).toBe("from-header")
		expect(cookieValue("SESSION", {}, { "set-cookie": "session=from-header" })).toBe("from-header")
		expect(cookieValue("missing", {}, { "set-cookie": "session=from-header" })).toBeUndefined()
		expect(cookieValue("session", { session: "" }, { "set-cookie": "session=" })).toBeUndefined()
	})

	it("merges and omits cookie headers", () => {
		expect(mergeCookieHeader(undefined, undefined)).toBeUndefined()
		expect(mergeCookieHeader("", "a=1")).toBe("a=1")
		expect(mergeCookieHeader(undefined, "a=1")).toBe("a=1")
		expect(mergeCookieHeader("a=1", "")).toBe("a=1")
		expect(mergeCookieHeader("a=1", undefined)).toBe("a=1")
		expect(mergeCookieHeader("a=1", "b=2")).toBe("a=1; b=2")
		const headers = { Cookie: "a=1", other: "x" }
		omitHeader(headers, "cookie")
		expect(headers).toEqual({ other: "x" })
		omitHeader(headers, "missing")
		expect(headers).toEqual({ other: "x" })
	})
})

describe("CookieJar", () => {
	it("scopes cookies to the host that set them", () => {
		const jar = new CookieJar()
		expect(jar.size).toBe(0)
		jar.absorb(new URL("https://app.example.com/verify"), [
			"session=abc; Path=/; HttpOnly",
			"HttpOnly",
			"empty=",
			"refresh=r1",
		])
		expect(jar.size).toBe(2)
		expect(jar.cookieHeader(new URL("https://app.example.com/app"))).toBe("session=abc; refresh=r1")
		expect(jar.cookieHeader(new URL("https://other.example.com/"))).toBeUndefined()
		expect(jar.snapshot()).toEqual({ refresh: "r1", session: "abc" })
		jar.absorb(new URL("https://app.example.com/"), ["session=new"])
		expect(jar.snapshot().session).toBe("new")

		const headers: Record<string, string> = { cookie: "pre=1", authorization: "Bearer x" }
		applyJarToHeaders(headers, jar, new URL("https://app.example.com/"))
		expect(headers.cookie).toContain("pre=1")
		expect(headers.cookie).toContain("session=new")
		const empty: Record<string, string> = {}
		applyJarToHeaders(empty, jar, new URL("https://other.example.com/"))
		expect(empty.cookie).toBeUndefined()
		applyJarToHeaders(empty, jar, new URL("https://app.example.com/"))
		expect(empty.cookie).toContain("session=new")
	})
})

describe("redirectTarget", () => {
	it("follows 301/302/303/307/308 and rejects the rest", () => {
		expect(isRedirectStatus(301)).toBe(true)
		expect(isRedirectStatus(304)).toBe(false)
		expect(isRedirectStatus(200)).toBe(false)
		const current = new URL("https://app.example.com/verify?t=1")
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
		expect(redirectTarget(307, "POST", "/next", current)).toEqual({
			dropBody: false,
			method: "POST",
			url: new URL("https://app.example.com/next"),
		})
		expect(redirectTarget(308, "PUT", "https://app.example.com/kept", current)).toEqual({
			dropBody: false,
			method: "PUT",
			url: new URL("https://app.example.com/kept"),
		})
		expect(redirectTarget(303, "GET", null, current)).toBeNull()
		expect(redirectTarget(303, "GET", "", current)).toBeNull()
		expect(redirectTarget(200, "GET", "/app", current)).toBeNull()
		expect(redirectTarget(303, "GET", "ftp://x/y", current)).toBeNull()
		expect(redirectTarget(303, "GET", "http://[", current)).toBeNull()
		expect(redirectTarget(302, "GET", "/next", current)?.dropBody).toBe(false)
	})
})

describe("describeSaveAs / readSaveAs", () => {
	it("addresses cookies, headers, and JSON paths", () => {
		expect(describeSaveAs("cookie:session")).toEqual({ kind: "cookie", name: "session" })
		expect(describeSaveAs("COOKIE: session")).toEqual({ kind: "cookie", name: "session" })
		expect(describeSaveAs("cookie:")).toEqual({ kind: "cookie", name: "" })
		expect(describeSaveAs("header:x-request-id")).toEqual({ kind: "header", name: "x-request-id" })
		expect(describeSaveAs("Header: X-Foo")).toEqual({ kind: "header", name: "X-Foo" })
		expect(describeSaveAs("$.access_token")).toEqual({ kind: "json", path: "$.access_token" })
		expect(describeSaveAs("plain")).toEqual({ kind: "json", path: "plain" })

		const source = {
			body: { access_token: "from-json" },
			cookies: { session: "from-jar" },
			headers: { "x-request-id": "rid", "set-cookie": "refresh=from-set" },
			readJson: jsonPath,
		}
		expect(readSaveAs("cookie:session", source)).toBe("from-jar")
		expect(readSaveAs("cookie:refresh", source)).toBe("from-set")
		expect(readSaveAs("cookie:", source)).toBeUndefined()
		expect(readSaveAs("cookie:missing", source)).toBeUndefined()
		expect(readSaveAs("header:x-request-id", source)).toBe("rid")
		expect(readSaveAs("header:set-cookie", source)).toBeUndefined()
		expect(readSaveAs("header:", source)).toBeUndefined()
		expect(readSaveAs("header:missing", source)).toBeUndefined()
		expect(readSaveAs("header:empty", { ...source, headers: { empty: "" } })).toBeUndefined()
		expect(readSaveAs("$.access_token", source)).toBe("from-json")
	})
})
