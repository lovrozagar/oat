import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { Redactor } from "../security/redact.ts"
import { belowBase, toCurl } from "./curl.ts"

const exchange = (more: Partial<Exchange>): Exchange =>
	({ method: "POST", requestHeaders: {}, url: "https://api.test/v1/rows", ...more }) as Exchange

describe("belowBase", () => {
	it("is what follows a base the target lies under", () => {
		expect(belowBase("/api/x", "/api/")).toBe("/x")
		expect(belowBase("/api?q=1", "/api")).toBe("?q=1")
		expect(belowBase("/api", "/api")).toBe("")
	})

	it("is undefined for a sibling or another path", () => {
		expect(belowBase("/apiv2/x", "/api")).toBeUndefined()
		expect(belowBase("/other", "/api")).toBeUndefined()
	})
})

describe("toCurl", () => {
	it("quotes the URL, or points it at $BASE when it lies under the origin", () => {
		const redactor = new Redactor()
		expect(toCurl(exchange({ url: "https://api.test/it's" }), { redactor })).toBe(
			"curl -i -X POST 'https://api.test/it'\\''s'",
		)
		expect(toCurl(exchange({}), { origin: "https://api.test/v1", redactor })).toBe('curl -i -X POST "$BASE/rows"')
		expect(
			toCurl(exchange({ url: "https://api.test/v1/rows?q=`x`" }), { origin: "https://api.test/v1", redactor }),
		).toBe('curl -i -X POST "$BASE/rows?q=\\`x\\`"')
	})

	it("puts a secret header behind $TOKEN, keeping its scheme, and scrubs issued values elsewhere", () => {
		const redactor = new Redactor()
		redactor.registerSecret("s3cr3t-value")
		const curl = toCurl(
			exchange({
				requestHeaders: { "x-api-key": "k", authorization: "Bearer abc", "x-note": "id s3cr3t-value" },
			}),
			{ redactor },
		)
		expect(curl).toContain('-H "x-api-key: $TOKEN"')
		expect(curl).toContain('-H "authorization: Bearer $TOKEN"')
		expect(curl).not.toContain("s3cr3t-value")
	})

	it("hides exactly the named headers when given a list", () => {
		const curl = toCurl(exchange({ requestHeaders: { authorization: "Bearer abc", "X-Custom": "c" } }), {
			redact: ["x-custom"],
			redactor: new Redactor(),
		})
		expect(curl).toContain("-H 'authorization: Bearer abc'")
		expect(curl).toContain('-H "X-Custom: $TOKEN"')
	})
})

describe("toCurl bodies", () => {
	it("sends JSON and text bodies with -d, scrubbed", () => {
		const redactor = new Redactor()
		expect(toCurl(exchange({ requestBody: { password: "p", a: 1 } }), { redactor })).toContain(
			`-d '{"password":"<redacted>","a":1}'`,
		)
		expect(toCurl(exchange({ requestBody: "it's" }), { redactor })).toContain(`-d 'it'\\''s'`)
	})

	it("keeps registered secrets out, header and form field alike, and sends a form field by field", () => {
		const redactor = new Redactor()
		redactor.registerSecret("hunter2-password")
		redactor.registerSecret("Bearer tok_live_123456")
		const requestBody = new URLSearchParams([
			["username", "oat"],
			["password", "hunter2-password"],
		])
		const curl = toCurl(exchange({ requestBody, requestHeaders: { authorization: "Bearer tok_live_123456" } }), {
			redactor,
		})
		expect(curl).not.toContain("hunter2-password")
		expect(curl).not.toContain("tok_live_123456")
		expect(curl).toContain("--data-urlencode 'username=oat'")
	})

	it("sends form fields one by one, secrets scrubbed", () => {
		const curl = toCurl(exchange({ requestBody: new URLSearchParams({ a: "1", token: "t" }) }), {
			redactor: new Redactor(),
		})
		expect(curl).toContain("--data-urlencode 'a=1'")
		expect(curl).toContain("--data-urlencode 'token=<redacted>'")
	})

	it("sends multipart parts as -F, live or compacted", () => {
		const form = new FormData()
		form.append("title", "scan")
		form.append("file", new File([new Uint8Array([1])], "a.bin"))
		form.append("typed", new File(["x"], "b.txt", { type: "text/plain" }))
		const live = toCurl(exchange({ requestBody: form }), { redactor: new Redactor() })
		expect(live).toContain("-F 'title=scan'")
		expect(live).toContain("-F 'file=@a.bin;type=application/octet-stream'")
		expect(live).toContain("-F 'typed=@b.txt;type=text/plain'")
		const snapshot = {
			parts: [
				{ field: "title", value: "scan" },
				{ bytes: 1, field: "file", filename: "a.bin", mediaType: "image/png", sha256: "00" },
			],
		}
		const compacted = toCurl(exchange({ requestBody: snapshot }), { redactor: new Redactor() })
		expect(compacted).toContain("-F 'title=scan'")
		expect(compacted).toContain("-F 'file=@a.bin;type=image/png'")
	})
})

describe("toCurl form redaction", () => {
	it("scrubs form fields and multipart parts by a secret or placed name, and by an issued value", () => {
		const redactor = new Redactor()
		redactor.registerQuery("k")
		redactor.registerSecret("issued-value-1")
		const form = new FormData()
		form.append("password", "p")
		form.append("k", "placed")
		form.append("note", "has issued-value-1")
		const snapshot = {
			parts: [
				{ field: "k", value: "placed" },
				{ field: "note", value: "issued-value-1" },
			],
		}
		const fields = new URLSearchParams({ k: "placed", note: "issued-value-1" })
		const written = [form, snapshot, fields].map((body) => toCurl(exchange({ requestBody: body }), { redactor }))
		for (const curl of written) expect(curl).not.toMatch(/placed|issued-value-1/)
		expect(written[0]).toContain("-F 'password=<redacted>'")
		expect(written[0]).toContain("-F 'note=has <redacted>'")
		expect(written[2]).toContain("--data-urlencode 'k=<redacted>'")
	})
})

describe("toCurl raw bodies", () => {
	it("reads bytes from stdin, and sends no body flag without a body", () => {
		const redactor = new Redactor()
		expect(toCurl(exchange({ requestBody: new Uint8Array([1]) }), { redactor })).toContain("--data-binary @-")
		const ref = { bytes: 9, mediaType: "application/json", sha256: "ab" }
		expect(toCurl(exchange({ requestBody: ref }), { redactor })).toContain("--data-binary @-")
		expect(toCurl(exchange({ method: "GET" }), { redactor })).toBe("curl -i -X GET 'https://api.test/v1/rows'")
	})
})
