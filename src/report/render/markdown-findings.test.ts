import { describe, expect, it } from "vitest"
import { Redactor } from "../../security/redact.ts"
import { BASE, exchange, finding } from "./__fixtures__/report.ts"
import { exchangeBlock, findingSections } from "./markdown-findings.ts"

describe("exchangeBlock", () => {
	it("states the request line, status, timing and sizes, with no bodies when there were none", () => {
		expect(exchangeBlock(exchange({ durationMs: 12, requestBytes: 2048, responseBytes: 10 }), new Redactor())).toEqual([
			"",
			"`GET /v1/rows` → **200** (1970-01-01T00:00:00.000Z · 12ms · 2.0 KB → 10 bytes)",
		])
	})

	it("collapses both bodies, scrubbed, and names the request id", () => {
		const redactor = new Redactor()
		redactor.registerSecret("s3cret")
		const lines = exchangeBlock(
			exchange({
				method: "POST",
				requestBody: { password: "hunter2", title: "x" },
				requestId: "req-1",
				responseBody: "token s3cret",
				status: 201,
				url: `${BASE}/v1/rows?token=s3cret&page=2`,
			}),
			redactor,
		)
		expect(lines[1]).toMatch(/^`POST \/v1\/rows\?token=.*&page=2` → \*\*201\*\* \(.* · req-1\)$/)
		expect(lines.join("\n")).not.toContain("s3cret")
		expect(lines.join("\n")).not.toContain("hunter2")
		expect(lines.slice(2, 10)).toEqual([
			"",
			"<details><summary>request body</summary>",
			"",
			"```json",
			'{\n  "password": "<redacted>",\n  "title": "x"\n}',
			"```",
			"",
			"</details>",
		])
		expect(lines).toContain("<details><summary>response body</summary>")
	})
})

describe("findingSections", () => {
	it("writes a section per severity, each finding with up to three exchanges and its repro script", () => {
		const evidence = [1, 2, 3, 4].map((seq) => exchange({ seq, url: `${BASE}/v1/rows/${seq}` }))
		const lines = findingSections(
			[
				finding({ verdict: "SPEC_BUG", entity: "row", summary: "drift" }),
				finding({ evidence, fixture: "a.png", summary: "broken" }),
			],
			new Redactor(),
		)
		const text = lines.join("\n")
		expect(text.indexOf("## Backend defects")).toBeLessThan(text.indexOf("## Specification drift"))
		expect(lines).toContain("### row · a.png — broken")
		expect(lines).toContain("> The backend is defensible; the document disagrees. Generated clients will break.")
		expect(text).toContain("/v1/rows/3")
		expect(text).not.toContain("/v1/rows/4")
		expect(lines).toContain("Reproduce: `issue-repro/row-sort-order-is-applied.sh`")
		expect(lines.filter((line) => line.startsWith("Reproduce:"))).toHaveLength(1)
	})

	it("writes nothing with no findings", () => {
		expect(findingSections([], new Redactor())).toEqual([])
	})
})
