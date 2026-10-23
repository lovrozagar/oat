import { describe, expect, it } from "vitest"
import { BASE, exchange, finding, operation, reportOf, scopeOf } from "./__fixtures__/report.ts"
import { renderStepSummary, STEP_SUMMARY_LIMIT } from "./step-summary.ts"

/* The run as a GitHub job summary: the verdict, the operations, the findings, and where the rest is. */

const RUN_DIR = "/w/.oat/runs/2026-10-22T10-00-00Z"
const render = (input = reportOf()) => renderStepSummary(input, { runDir: RUN_DIR })
const bytes = (text: string) => Buffer.byteLength(text, "utf8")

const graded = () =>
	scopeOf({
		operations: [
			operation(),
			operation({ operationId: "row.get", status: "failed" }),
			operation({ operationId: "row.del", status: "inconclusive" }),
			operation({ operationId: "row.put", status: "blocked" }),
			operation({ operationId: "row.patch", status: "untested" }),
			operation({ operationId: "row.head", status: "untested" }),
		],
	})

describe("renderStepSummary", () => {
	it("heads with outcome and exit code", () => {
		const text = render(
			reportOf({ findings: [finding()], profile: "cheap", scope: graded() }, [exchange(), exchange()]),
		)
		expect(text.split("\n").slice(0, 5)).toEqual([
			"## oat: defects (exit 1)",
			"",
			`\`${BASE}\` · profile cheap · 1 checks · 1 entities · 2 requests · 1.5s`,
			"",
			"**1 root-cause finding**",
		])
		expect(text.endsWith(`Full report: \`${RUN_DIR}/oat-report.md\`\n`)).toBe(true)
	})

	it("tables operations by status", () => {
		const text = render(reportOf({ scope: graded() }))
		expect(text).toContain(
			[
				"| operations | passed | failed | inconclusive | blocked | untested |",
				"| ---: | ---: | ---: | ---: | ---: | ---: |",
				"| 6 | 1 | 1 | 1 | 1 | 2 |",
			].join("\n"),
		)
		expect(render()).toContain("| 0 | 0 | 0 | 0 | 0 | 0 |")
	})

	it("lists failing root causes before known ones and counts gaps", () => {
		const text = render(
			reportOf({
				baseline: { fixed: [{ check: "x", entity: "row", reason: "r" }] },
				findings: [
					finding({ check: "k", known: { reason: "#1" }, summary: "known one", verdict: "SECURITY" }),
					finding({ check: "b", summary: "backend" }),
					finding({ check: "s", entity: "tag", origin: "billing", summary: "security", verdict: "SECURITY" }),
					finding({ check: "g", verdict: "COVERAGE_GAP" }),
					finding({ check: "g2", verdict: "COVERAGE_GAP" }),
					finding({ check: "bl", verdict: "BLOCKED" }),
				],
				scope: graded(),
			}),
		)
		expect(text).toContain(
			[
				"### Findings",
				"",
				"| verdict | subject | check | summary |",
				"| --- | --- | --- | --- |",
				"| SECURITY | billing/tag | `s` | security |",
				"| BACKEND_BUG | row | `b` | backend |",
				"| SECURITY (known) | row | `k` | known one |",
				"",
				"2 coverage gaps · 1 blocked, listed in oat-report.md",
			].join("\n"),
		)
		expect(text).toContain("Baseline: 1 known · 1 fixed")
	})
})

describe("renderStepSummary, the text", () => {
	it("escapes pipes, markup and newlines in cells, and redacts secrets", () => {
		const input = reportOf({
			findings: [finding({ check: "c|d", summary: "a | b\nc\r\nd <img src=x> sk-live-123456" })],
			scope: graded(),
		})
		input.client.redactor.registerSecret("sk-live-123456")
		const text = render(input)
		expect(text).toContain("| BACKEND_BUG | row | `c\\|d` | a \\| b c d &lt;img src=x> &lt;redacted> |")
		expect(text).not.toContain("sk-live-123456")
	})

	it("lists what went untested in a collapsed section", () => {
		const text = render(
			reportOf({
				checksRun: ["a", "b"],
				checksSuppressed: [
					{ because: "auth.required", check: "a", entity: "row" },
					{ because: "seed.create", check: "b", entity: "row" },
				],
				entitiesTested: ["row", "tag"],
				inconclusive: [{ check: "i", entity: "row", reason: "empty\nlisting" }],
				scope: graded(),
			}),
		)
		expect(text).toContain(
			[
				"<details><summary>Untested (3)</summary>",
				"",
				"- `a`: blocked on 1 of 2 entities, waiting on auth.required",
				"- `b`: blocked on 1 of 2 entities, waiting on seed.create",
				"- `i`: could not conclude: empty listing",
				"",
				"</details>",
			].join("\n"),
		)
		const everywhere = render(
			reportOf({
				checksSuppressed: [{ because: "auth.required", check: "sort.order-is-applied", entity: "row" }],
				scope: graded(),
			}),
		)
		expect(everywhere).toContain("- `sort.order-is-applied`: blocked by an earlier failure, waiting on auth.required")
	})

	it("a clean run says no defects found", () => {
		const text = render(reportOf({ scope: graded() }))
		expect(text).toContain("**no defects found in what was graded**")
		expect(text).toContain("### Findings\n\nNo defects found.\n")
		expect(text).not.toContain("<details>")
		expect(text).not.toContain("Baseline:")
	})

	it("says a run was interrupted", () => {
		expect(render(reportOf({ interrupted: true, scope: graded() }))).toContain(
			"Interrupted by a signal: what ran before it is reported.",
		)
	})
})

describe("renderStepSummary, the bound", () => {
	it("stays within 65536 bytes and says how many rows it left out", () => {
		const long = "x".repeat(400)
		const findings = Array.from({ length: 400 }, (_, i) => finding({ check: `c${i}`, summary: long }))
		const inconclusive = Array.from({ length: 50 }, (_, i) => ({
			check: `i${i}`,
			entity: "row",
			reason: long.repeat(5),
		}))
		const text = render(reportOf({ findings, inconclusive, scope: graded() }))
		expect(STEP_SUMMARY_LIMIT).toBe(65_536)
		expect(bytes(text)).toBeLessThanOrEqual(STEP_SUMMARY_LIMIT)
		expect(text).toContain("<details><summary>Untested (50)</summary>\n\n- … and 50 more, truncated, see")
		const shown = text.split("\n").filter((line) => line.startsWith("| BACKEND_BUG")).length
		expect(shown).toBeGreaterThan(100)
		expect(text).toContain(`\n\n… and ${400 - shown} more, truncated, see ${RUN_DIR}\n`)
		expect(text.endsWith(`Full report: \`${RUN_DIR}/oat-report.md\`\n`)).toBe(true)
		const fewer = render(reportOf({ findings: findings.slice(0, 20), inconclusive, scope: graded() }))
		expect(bytes(fewer)).toBeLessThanOrEqual(STEP_SUMMARY_LIMIT)
		expect(fewer.split("\n").filter((line) => line.startsWith("| BACKEND_BUG"))).toHaveLength(20)
		expect(fewer).toMatch(/- … and \d+ more, truncated, see /)
	})

	it("cuts at a line boundary when the head alone is too long", () => {
		const huge = `${BASE}/${"p".repeat(STEP_SUMMARY_LIMIT)}`
		const text = render(reportOf({ baseUrl: huge, scope: graded() }))
		expect(bytes(text)).toBeLessThanOrEqual(STEP_SUMMARY_LIMIT)
		expect(text).toBe(`## oat: clean (exit 0)\n\n… truncated, see ${RUN_DIR}\n`)
	})
})
