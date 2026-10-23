import { describe, expect, it } from "vitest"
import { BASE, exchange, finding, reportOf, scopeOf } from "./__fixtures__/report.ts"
import { REPORT_SCHEMA_VERSION, renderJson } from "./json.ts"

describe("the JSON report", () => {
	it("scrubs what the run's redactor learned, as well as secret names", () => {
		const input = reportOf({
			findings: [
				finding({
					evidence: [
						exchange({
							requestHeaders: { authorization: "Bearer x" },
							url: `${BASE}/v1/rows?next=issued-secret-value`,
						}),
					],
				}),
			],
		})
		input.client.redactor.registerSecret("issued-secret-value")
		const text = renderJson(input)
		expect(text).not.toContain("issued-secret-value")
		expect(text).toContain("<redacted>")
	})

	it("states schemaVersion 1 first", () => {
		const text = renderJson(reportOf())
		expect(REPORT_SCHEMA_VERSION).toBe(1)
		expect(text.startsWith('{\n  "schemaVersion": 1,\n')).toBe(true)
	})

	it("gives a plain run's fields their defaults, in a stable order", () => {
		const report = JSON.parse(renderJson(reportOf()))
		expect(Object.keys(report)).toEqual([
			"schemaVersion",
			"backend",
			"outcome",
			"checksRun",
			"checksSkipped",
			"checksSuppressed",
			"inconclusive",
			"profile",
			"profileExclusions",
			"checksOutOfScope",
			"durationMs",
			"entitiesTested",
			"findings",
			"generatedAt",
			"requests",
			"requestBytes",
			"responseBytes",
			"latency",
			"costByCheck",
			"observed",
			"summary",
			"coverage",
		])
		expect(report.outcome).toEqual({ exitCode: 0, reason: "no defects found in what was graded", result: "clean" })
		expect(report.profile).toBe("full")
		expect(report.latency).toBeNull()
		expect(report.summary).toEqual({})
		expect(report.coverage).toEqual({ neverApplied: [], partial: [] })
	})
})

describe("the JSON report and a sign-in answered as a form", () => {
	it("scrubs a token pair a sign-in answered as a form, by field name", () => {
		const answered = exchange({
			responseBody: "access_token=acc-tok-123456&refresh_token=rt-9876543210",
			responseHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
		})
		const text = renderJson(reportOf({ findings: [finding({ evidence: [answered] })] }))
		expect([text.includes("acc-tok-123456"), text.includes("rt-9876543210")]).toEqual([false, false])
	})
})

describe("the JSON report's optional parts", () => {
	it("carries every optional part a run produced", () => {
		const input = reportOf(
			{
				baseline: { fixed: [] },
				checksSkipped: [
					{ check: "never", entity: "row", needs: "x" },
					{ check: "some", entity: "row", needs: "x" },
				],
				entitiesTested: ["row", "table"],
				fenced: {
					failRun: true,
					requests: [{ method: "GET", phase: "load", reason: "no", url: `${BASE}/v1/rows?token=abc` }],
				},
				findings: [
					finding({
						evidence: [exchange({ requestBody: { a: 1 }, responseBody: { b: 2 } })],
						fixture: "a.png",
						known: { reason: "t" },
						operations: ["row.list"],
					}),
					finding({ verdict: "SECURITY" }),
				],
				interrupted: true,
				network: { attempts: 1, incomplete: false, kind: "reset", url: BASE, waitedMs: 0 },
				scope: scopeOf(),
				targetVersion: { value: "9" },
				teardown: { failed: [], records: [], removed: 1, unidentified: [], unsupported: [] },
			},
			[exchange({ durationMs: 7 })],
		)
		const report = JSON.parse(renderJson(input))
		expect(report.scope.mode).toBe("full")
		expect(report.teardown.removed).toBe(1)
		expect(report.network.kind).toBe("reset")
		expect(report.interrupted).toBe(true)
		expect(report.baseline).toEqual({ fixed: [] })
		expect(report.targetVersion).toEqual({ value: "9" })
		expect(report.fenced).toEqual({
			failRun: true,
			requests: [{ method: "GET", phase: "load", reason: "no", url: `${BASE}/v1/rows?token=%3Credacted%3E` }],
		})
		expect(report.findings[0]).toMatchObject({ fixture: "a.png", known: { reason: "t" }, operations: ["row.list"] })
		expect(report.findings[0].evidence[0]).toMatchObject({
			at: "1970-01-01T00:00:00.000Z",
			requestBody: { a: 1 },
			responseBody: { b: 2 },
		})
		expect(report.summary).toEqual({ BACKEND_BUG: 1, SECURITY: 1 })
		expect(report.latency.max).toBe(7)
		expect(report.coverage).toEqual({
			neverApplied: [],
			partial: [
				{ check: "never", ran: 1, skipped: 1 },
				{ check: "some", ran: 1, skipped: 1 },
			],
		})
	})
})

describe("the JSON report's absent parts", () => {
	it("keeps the origin a secondary host's finding came from, so diff tells it from the primary's", () => {
		const text = renderJson(reportOf({ findings: [finding({ origin: "cdn" }), finding()] }))
		const [cdn, primary] = (JSON.parse(text) as { findings: Array<Record<string, unknown>> }).findings
		expect(cdn?.origin).toBe("cdn")
		expect(primary !== undefined && "origin" in primary).toBe(false)
	})

	it("names the checks that applied nowhere", () => {
		const input = reportOf({ checksSkipped: [{ check: "never", entity: "row", needs: "x" }] })
		expect(JSON.parse(renderJson(input)).coverage).toEqual({ neverApplied: ["never"], partial: [] })
	})

	it("leaves out a teardown that did not run", () => {
		expect(JSON.parse(renderJson(reportOf({ teardown: null }))).teardown).toBeUndefined()
	})
})
