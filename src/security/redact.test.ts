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
