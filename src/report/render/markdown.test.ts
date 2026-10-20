import { describe, expect, it } from "vitest"
import { reportInput } from "../../cli/commands/run-report.ts"
import { PRINCIPALS, SECURITY } from "../../conformance/matrix/principals.ts"
import { createMemoryReference } from "../../reference/http/engines.ts"
import { run } from "../../runtime/run/index.ts"
import { exchange, finding, reportOf, scopeOf } from "./__fixtures__/report.ts"
import { renderMarkdown } from "./markdown.ts"

const order = (text: string, headings: string[]): number[] => headings.map((heading) => text.indexOf(heading))

describe("renderMarkdown", () => {
	it("lays the report out in a fixed order: summary, leftovers, fence, observations, outcome, scope, baseline, findings, coverage", () => {
		const text = renderMarkdown(
			reportOf({
				baseline: { fixed: [{ check: "gone", reason: "fixed" }] },
				checkNotes: [{ check: "a", entity: "row", note: "PATCH merges" }],
				checksSkipped: [{ check: "never", entity: "row", needs: "a list" }],
				fenced: {
					failRun: false,
					requests: [{ method: "DELETE", phase: "teardown", reason: "no", url: "http://h.test/x" }],
				},
				findings: [
					finding({ evidence: [exchange()] }),
					finding({ check: "known.check", known: { reason: "TICKET-2" } }),
				],
				scope: scopeOf(),
				teardown: {
					failed: [{ entity: "row", id: "1", principal: "alpha", reason: "still there" }],
					records: [],
					removed: 0,
					unidentified: [],
					unsupported: [],
				},
			}),
		)
		const headings = [
			"# oat report",
			"## Leftovers",
			"## Fenced requests",
			"## Observed behaviour",
			"## Summary",
			"## Operations",
			"## Known",
			"## Fixed",
			"## Backend defects",
			"## Did not apply anywhere",
		]
		const at = order(text, headings)
		expect(at.every((index) => index >= 0)).toBe(true)
		expect(at).toEqual([...at].sort((a, b) => a - b))
		/* A known finding is reported under Known, not counted among the defects. */
		expect(text).toContain("| Backend defects | 1 |")
		expect(text).toContain("_(known: TICKET-2)_")
		expect(text.endsWith("\n")).toBe(true)
	})

	it("reports a clean run in a few lines", () => {
		const text = renderMarkdown(reportOf())
		expect(text).toContain("No defects found across 1 checks.")
		expect(text).not.toContain("## ")
	})
})

describe("renderMarkdown on a real run", () => {
	it("renders a real run against the reference: a stale list is a backend defect with its repro", async () => {
		const ref = await createMemoryReference({ defects: ["STALE_LIST"] })
		try {
			const network = { fetch: ref.fetch }
			const startedAt = new Date(0)
			const result = await run({
				baseUrl: ref.url,
				network,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${ref.url}/v1/openapi/spec`,
			})
			const text = renderMarkdown(reportInput({ baseUrl: ref.url, durationMs: 1, outDir: "", result, startedAt }))
			expect(text).toContain("## Backend defects")
			expect(text).toMatch(/Reproduce: `issue-repro\/[a-z0-9-]+\.sh`/)
			expect(text).toContain("## Operations")
		} finally {
			await ref.close()
		}
	})
})
