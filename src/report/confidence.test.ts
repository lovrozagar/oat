import { describe, expect, it } from "vitest"
import {
	confidenceGroups,
	exchangeFilesFromIndex,
	renderConfidenceHtml,
	renderConfidenceMarkdown,
} from "./confidence.ts"
import type { OperationCoverage, ScopeReport } from "../runtime/scope/types.ts"

/*
 * The page a person opens after a run: every operation in exactly one group, worst first, each with
 * one line on why it sits there and a link to the request that proves it.
 */

const none = { failed: [], gaps: [], inconclusive: [], passed: [], suppressed: [] }
const row = (over: Partial<OperationCoverage> & { operationId: string }): OperationCoverage => ({
	checks: none,
	entity: null,
	findings: 0,
	reason: null,
	status: "passed",
	...over,
})

const scope: ScopeReport = {
	excluded: [],
	mode: "full",
	operations: [
		row({
			operationId: "health.get",
			evidence: { call: 1 },
			sufficiency: "complete",
			tier: "contract",
			why: "a read with no declared effects: its contract is the whole promise",
		}),
		row({
			operationId: "note.create",
			evidence: { call: 2, observation: { path: "$.id", seq: 3, value: "n1" } },
			sufficiency: "verified",
			tier: "verified",
			why: "a later exchange shows what this call did",
		}),
		row({
			operationId: "notify.send",
			evidence: { call: 4 },
			sufficiency: "unproven",
			tier: "contract",
			why: "met its contract, but no later read observed what it changed",
		}),
		row({
			operationId: "extract.once",
			checks: { ...none, failed: ["response.no-server-error"] },
			findings: 1,
			status: "failed",
		}),
		row({ operationId: "billing.offer", reason: 'blocked by scenario "offer-redeem"', status: "blocked" }),
	],
	originsSkipped: [],
	requested: { ops: [], only: [] },
	support: [],
}
const files = new Map([
	[1, "exchanges/req-1.json"],
	[2, "exchanges/req-2.json"],
	[3, "exchanges/req-3.json"],
	[4, "exchanges/req-4.json"],
])

describe("confidence groups", () => {
	it("puts every operation in exactly one group, worst first", () => {
		const groups = confidenceGroups(scope, files)
		expect(groups.map((group) => [group.key, group.rows.map((r) => r.operation)])).toEqual([
			["failed", ["extract.once"]],
			["blocked", ["billing.offer"]],
			["unproven", ["notify.send"]],
			["verified", ["note.create"]],
			["complete", ["health.get"]],
		])
		const failed = groups[0]?.rows[0]
		expect(failed?.why).toContain("response.no-server-error")
		const verified = groups[3]?.rows[0]
		expect(verified?.evidence).toEqual(["exchanges/req-2.json", "exchanges/req-3.json"])
	})

	it("renders a standalone page with counts, reasons and evidence links", () => {
		const html = renderConfidenceHtml(
			{ baseUrl: "https://api.example.test", generatedAt: "2026-10-13T00:00:00Z", scope },
			files,
		)
		expect(html.startsWith("<!doctype html>")).toBe(true)
		expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/)
		for (const label of ["Failed", "Blocked", "Effects unproven", "Verified", "Complete by contract"]) {
			expect(html).toContain(label)
		}
		expect(html).toContain('href="exchanges/req-3.json"')
		expect(html).toContain("a read with no declared effects")
		expect(html).toContain("5 operations")
	})
})

describe("exchange index", () => {
	it("maps each request's seq to its saved file, skipping lines it cannot read", () => {
		const index = [
			JSON.stringify({ file: "exchanges/a.json", seq: 1 }),
			"not json",
			JSON.stringify({ seq: 2 }),
			JSON.stringify({ file: "exchanges/c.json", seq: 3 }),
		].join("\n")
		expect([...exchangeFilesFromIndex(index)]).toEqual([
			[1, "exchanges/a.json"],
			[3, "exchanges/c.json"],
		])
	})
})

describe("confidence in the markdown report", () => {
	it("opens with one count per group and points at the page", () => {
		const md = renderConfidenceMarkdown(scope)
		expect(md).toContain("## Confidence")
		expect(md).toContain("| Failed | 1 |")
		expect(md).toContain("| Complete by contract | 1 |")
		expect(md).toContain("[report.html](./report.html)")
	})
})
