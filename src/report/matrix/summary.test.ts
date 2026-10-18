import { describe, expect, it } from "vitest"
import { crowd, report } from "./__fixtures__/reports.ts"
import { buildMatrixGraphFromReport } from "./graph.ts"
import { summaryLine, thesisFor, totalCounts } from "./summary.ts"
import type { MatrixReport } from "./types.ts"

const said = (input: MatrixReport) => {
	const graph = buildMatrixGraphFromReport(input)
	const cross = graph.invalidate.filter((l) => l.cross)
	return {
		summary: summaryLine(graph.entities, totalCounts(graph.entities), cross),
		thesis: thesisFor(graph.entities, cross),
	}
}

describe("totalCounts", () => {
	it("adds every entity's counts", () => {
		const graph = buildMatrixGraphFromReport(
			report({
				cells: { a: { "sort.order-is-applied": "failed" }, b: { "patch.minimality": "out-of-scope" } },
				entities: ["a", "b"],
			}),
		)
		const [a, b] = graph.entities
		expect(totalCounts(graph.entities)).toEqual({
			blocked: 0,
			failed: 1,
			"out-of-scope": 1,
			passed: (a?.counts.passed ?? 0) + (b?.counts.passed ?? 0),
			skipped: 0,
		})
	})
})

describe("summaryLine and thesisFor", () => {
	it("one clean entity: counts, no cross-entity claim, nothing to root", () => {
		expect(said(report({ entities: ["table"] }))).toEqual({
			summary: "table: 0 failed, 0 blocked, 57 passed, 0 skipped. No cross-entity invalidate.",
			thesis: "One entity. Invalidate stays on its own read surface, so the cross-entity check did not apply.",
		})
	})

	it("names the pairs and the roots, counts out-of-scope cells, and leads with the failure", () => {
		const input = report({
			cells: { row: { "list.read-after-write": "failed", "patch.minimality": "out-of-scope" } },
			entities: ["table", "row"],
			invalidates: [{ routes: ["GET /table"], writer: "row" }],
		})
		expect(said(input)).toEqual({
			summary:
				"table, row: 1 failed, 0 blocked, 112 passed, 0 skipped, 1 out of scope. Cross-entity invalidate: row → table. Roots: row:list.read-after-write.",
			thesis: "row had a check that disagreed. Composition checks that depend on it stood down — not extra defects.",
		})
	})

	it("says a clean claim between entities was tested, not believed", () => {
		const input = report({ entities: ["table", "row"], invalidates: [{ routes: ["GET /table"], writer: "row" }] })
		expect(said(input).thesis).toBe("2 entities. row writes must change table — that claim was tested, not believed.")
	})

	it("says several clean entities with no claim between them agreed", () => {
		expect(said(report({ entities: ["table", "row"] })).thesis).toBe("2 entities. Every check that applied agreed.")
	})

	it("counts a crowd instead of naming it, and leaves out more than eight roots", () => {
		const { summary, thesis } = said(crowd(13, (i) => (i + 1) % 13, [0, 1, 2, 3, 4, 5, 6, 7, 8]))
		expect(summary).toMatch(/^13 entities: 9 failed, .* 13 parents receive 13 cross-entity claims\.$/)
		expect(summary).not.toContain("Roots")
		expect(thesis).toContain("e0 had a check that disagreed")
	})

	it("counts the parents of a clean crowd's claims", () => {
		expect(said(crowd(12, (i) => i % 3)).thesis).toBe(
			"12 entities. 3 parents receive child writes (9 claims) — tested, not believed.",
		)
	})
})
