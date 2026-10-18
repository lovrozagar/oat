import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import type { Finding } from "../runtime/finding.ts"
import { buildSpec } from "../reference/spec/build.ts"
import { Client } from "../client/client.ts"
import { buildModel } from "../spec/graph.ts"
import { dereference } from "../spec/load.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { renderJson, renderRepros, type ReportInput } from "./render.ts"
import { Redactor } from "../security/redact.ts"

const exchange = (url: string, headers: Record<string, string> = {}): Exchange => ({
	at: 0,
	durationMs: 0,
	method: "GET",
	requestBody: undefined,
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
		const [script] = renderRepros(
			[finding([exchange("http://h.test/api/v1/rows")])],
			"http://h.test/api/",
			new Redactor(),
		)
		expect(script?.content).toContain('BASE="${BASE:-http://h.test/api}"')
		expect(script?.content).toContain('"$BASE/v1/rows"')
	})

	it("only abbreviate a URL that lies under the base path", () => {
		const [script] = renderRepros(
			[finding([exchange("http://h.test/apiv2/rows")])],
			"http://h.test/api",
			new Redactor(),
		)
		expect(script?.content).toContain("'http://h.test/apiv2/rows'")
		expect(script?.content).not.toContain("$BASE")
	})

	it("quote what they send, quotes included", () => {
		const [script] = renderRepros(
			[finding([exchange("http://other.test/it's", { "x-note": "it's" })])],
			"http://h.test",
			new Redactor(),
		)
		expect(script?.content).toContain(`'http://other.test/it'\\''s'`)
		expect(script?.content).toContain(`-H 'x-note: it'\\''s'`)
	})

	it("keep one file per finding when a check reports twice", () => {
		const scripts = renderRepros(
			[finding([exchange("http://h.test/a")]), finding([exchange("http://h.test/b")])],
			"http://h.test",
			new Redactor(),
		)
		expect(scripts.map((script) => script.filename)).toEqual([
			"row-sort-order-is-applied.sh",
			"row-sort-order-is-applied-2.sh",
		])
	})
})

const reportOf = (client: Client): ReportInput => ({
	baseUrl: "http://h.test",
	checksRun: ["sort.order-is-applied"],
	client,
	durationMs: 1,
	entitiesTested: ["row"],
	findings: [finding([exchange("http://h.test/v1/rows?next=issued-secret-value", { authorization: "Bearer x" })])],
	model: buildModel(dereference(buildSpec() as OpenApiDocument).doc),
	startedAt: new Date(0),
})

describe("the JSON report", () => {
	it("scrubs what the run's redactor learned, as well as secret names", () => {
		const client = new Client({ baseUrl: "http://h.test", redactor: new Redactor() })
		client.redactor.registerSecret("issued-secret-value")
		const text = renderJson(reportOf(client))
		expect(text).not.toContain("issued-secret-value")
		expect(text).toContain("<redacted>")
	})
})
