import { describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "./redact.ts"

describe("Redactor", () => {
	it("scrubs an issued credential wherever it appears, bare token included", () => {
		const redactor = new Redactor()
		redactor.registerSecret("Bearer tok_live_123456")
		expect(redactor.json({ message: "rejected tok_live_123456", nested: ["tok_live_123456"], n: 3 })).toEqual({
			message: `rejected ${REDACTED}`,
			n: 3,
			nested: [REDACTED],
		})
		expect(redactor.url("https://x.test/a?next=tok_live_123456")).not.toContain("tok_live_123456")
		expect(redactor.text("Bearer tok_live_123456")).toBe(REDACTED)
	})

	it("ignores a missing or too-short value", () => {
		const redactor = new Redactor()
		redactor.registerSecret(undefined)
		redactor.registerSecret(" abc ")
		expect(redactor.text("abc and more")).toBe("abc and more")
	})

	it("matches secret keys by family and a principal's own header name", () => {
		const redactor = new Redactor()
		redactor.registerHeader("X-Tenant-Credential")
		expect(redactor.json({ client_secret: "s", refreshToken: "r", sessionId: "q", total: null })).toEqual({
			client_secret: REDACTED,
			refreshToken: REDACTED,
			sessionId: REDACTED,
			total: null,
		})
		expect(redactor.headers({ "x-tenant-credential": "v", accept: "json", authorization: "x" })).toEqual({
			accept: "json",
			authorization: REDACTED,
			"x-tenant-credential": REDACTED,
		})
	})

	it("redacts every occurrence of a secret query parameter in place", () => {
		const params = new URL(new Redactor().url("https://x.test/a?token=one&q=1&token=two")).searchParams
		expect([...params.keys()]).toEqual(["token", "q", "token"])
		expect(params.getAll("token")).toEqual([REDACTED, REDACTED])
		expect(new Redactor().url("https://x.test/a?q=1")).toBe("https://x.test/a?q=1")
	})

	it("scrubs text it cannot parse as a URL", () => {
		const redactor = new Redactor()
		redactor.registerSecret("sk_secret_value")
		expect(redactor.url("not a url sk_secret_value")).toBe(`not a url ${REDACTED}`)
	})

	it("keeps two runs' secrets apart", () => {
		const first = new Redactor()
		first.registerSecret("first-run-secret")
		expect(new Redactor().text("first-run-secret")).toBe("first-run-secret")
	})
})

describe("Redactor.holdsSecret", () => {
	it("tells whether a value carries a registered credential, whole or inside it", () => {
		const redactor = new Redactor()
		redactor.registerSecret("Bearer tok_live_123456")
		expect(redactor.holdsSecret("tok_live_123456")).toBe(true)
		expect(redactor.holdsSecret("Bearer tok_live_123456")).toBe(true)
		expect(redactor.holdsSecret("id-tok_live_123456-x")).toBe(true)
		expect(redactor.holdsSecret("tok_live")).toBe(false)
		expect(redactor.holdsSecret("7")).toBe(false)
	})
})

describe("Redactor, placed credentials", () => {
	it("keeps an Authorization header's scheme word and scrubs the credential after it", () => {
		const headers = new Redactor().headers({
			Authorization: "ApiKey key_alpha_1",
			"proxy-authorization": "Basic dXNlcjpwYXNz",
			"x-api-key": "Bearer looks-like-a-scheme",
			authorization: "bare-token-value",
		})
		expect(headers).toEqual({
			Authorization: `ApiKey ${REDACTED}`,
			authorization: REDACTED,
			"proxy-authorization": `Basic ${REDACTED}`,
			"x-api-key": REDACTED,
		})
	})

	it("scrubs a registered query parameter by name, any value, and keeps the URL's shape", () => {
		const redactor = new Redactor()
		redactor.registerQuery("key")
		const url = new URL(redactor.url("https://x.test/a?key=k1&q=1&key=k2"))
		expect([...url.searchParams]).toEqual([
			["key", REDACTED],
			["q", "1"],
			["key", REDACTED],
		])
		expect(redactor.url("https://x.test/a?KEY=k1")).toBe("https://x.test/a?KEY=k1")
	})

	it("scrubs a registered cookie by name wherever a cookie pair is written", () => {
		const redactor = new Redactor()
		redactor.registerCookie("sid")
		expect(redactor.text("theme=dark; sid=abc; lang=en")).toBe(`theme=dark; sid=${REDACTED}; lang=en`)
		expect(redactor.text("sid=abc")).toBe(`sid=${REDACTED}`)
		expect(redactor.text("xsid=abc")).toBe("xsid=abc")
		redactor.registerCookie("a.b")
		expect(redactor.text("a.b=1;aXb=2")).toBe(`a.b=${REDACTED};aXb=2`)
	})
})

describe("Redactor, placed credentials in bodies", () => {
	it("scrubs a form field by its name or its value", () => {
		const redactor = new Redactor()
		redactor.registerQuery("key")
		redactor.registerSecret("issued-credential")
		expect(redactor.field("password", "hunter2")).toBe(REDACTED)
		expect(redactor.field("key", "anything")).toBe(REDACTED)
		expect(redactor.field("note", "sent issued-credential")).toBe(`sent ${REDACTED}`)
		expect(redactor.field("note", "plain")).toBe("plain")
	})

	it("registers every name and value a placement sends", () => {
		const redactor = new Redactor()
		redactor.registerPlacement({
			cookies: ["sid"],
			headers: ["X-Tenant-Credential"],
			query: ["api"],
			values: ["placed-secret-value"],
		})
		expect(redactor.headers({ "x-tenant-credential": "v" })).toEqual({ "x-tenant-credential": REDACTED })
		expect(redactor.url("https://x.test/?api=v")).toBe(`https://x.test/?api=${encodeURIComponent(REDACTED)}`)
		expect(redactor.text("sid=v; echo placed-secret-value")).toBe(`sid=${REDACTED}; echo ${REDACTED}`)
	})
})
