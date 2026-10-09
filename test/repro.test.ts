import { describe, expect, it } from "vitest"
import type { Exchange } from "../src/runtime/client.ts"
import type { Finding } from "../src/runtime/finding.ts"
import { renderRepros } from "../src/report/render.ts"

const exchange = (url: string, headers: Record<string, string> = {}): Exchange => ({
	at: 0,
	durationMs: 0,
	method: "GET",
	requestBytes: 0,
	requestHeaders: headers,
	requestId: "",
	responseBody: null,
	responseBytes: 0,
	responseHeaders: {},
	seq: 1,
	status: 200,
	url,
})

const finding = (evidence: Exchange[]): Finding => ({
	check: "sort.order-is-applied",
	detail: "d",
	entity: "row",
	evidence,
	summary: "s",
	verdict: "BACKEND_BUG",
})

describe("repro scripts", () => {
	it("replace the whole base URL, so a path prefix is not doubled", () => {
		const [script] = renderRepros([finding([exchange("http://h.test/api/v1/rows")])], "http://h.test/api/")
		expect(script?.content).toContain('BASE="${BASE:-http://h.test/api}"')
		expect(script?.content).toContain('"$BASE/v1/rows"')
	})

	it("quote what they send, quotes included", () => {
		const [script] = renderRepros(
			[finding([exchange("http://other.test/it's", { "x-note": "it's" })])],
			"http://h.test",
		)
		expect(script?.content).toContain(`'http://other.test/it'\\''s'`)
		expect(script?.content).toContain(`-H 'x-note: it'\\''s'`)
	})

	it("keep one file per finding when a check reports twice", () => {
		const scripts = renderRepros(
			[finding([exchange("http://h.test/a")]), finding([exchange("http://h.test/b")])],
			"http://h.test",
		)
		expect(scripts.map((script) => script.filename)).toEqual([
			"row-sort-order-is-applied.sh",
			"row-sort-order-is-applied-2.sh",
		])
	})
})
