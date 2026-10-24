import { describe, expect, it } from "vitest"
import { crowd, report } from "./__fixtures__/reports.ts"
import { USES } from "./catalog.ts"
import { buildMatrixGraphFromReport } from "./graph.ts"
import { mermaidFromGraph } from "./mermaid.ts"
import type { MatrixReport } from "./types.ts"

const mermaidOf = (input: MatrixReport): string[] => {
	const graph = buildMatrixGraphFromReport(input)
	return mermaidFromGraph(graph.entities, graph.invalidate).split("\n")
}

describe("mermaidFromGraph", () => {
	it("draws the entities, their cross-entity claims, and the focus entity's checks", () => {
		const lines = mermaidOf(
			report({
				cells: {
					"row.v2": {
						"query.axes-compose": "blocked",
						"query.filter-and-select-compose": "out-of-scope",
						"query.search-and-filter-compose": "skipped",
						"sort.order-is-applied": "failed",
					},
				},
				entities: ["table", "row.v2"],
				invalidates: [{ routes: ["GET /table", "GET /row.v2"], writer: "row.v2" }],
			}),
		)
		expect(lines.slice(0, 4)).toEqual([
			"flowchart LR",
			"  table((table))",
			"  row_v2((row.v2))",
			"  row_v2 -->|invalidates| table",
		])
		expect(lines).toContain('  row_v2__list_read_after_write["list"]')
		expect(lines).toContain("  row_v2 --> row_v2__list_read_after_write")
		expect(lines).toContain("  row_v2 --> row_v2__tenant_item_not_readable_cross_tenant")
		expect(lines).toContain("  row_v2 --> row_v2__sort_order_is_applied")
		expect(lines).not.toContain("  row_v2 --> row_v2__consistency_projections_agree")
		expect(lines).not.toContain("  row_v2 --> row_v2__query_axes_compose")
		expect(lines).toContain("  class row_v2__sort_order_is_applied failed")
		expect(lines).toContain("  row_v2__filter_equality_selects_exactly_one -.-> row_v2__query_axes_compose")
		expect(lines).toContain("  row_v2__select_projection_honored -.-> row_v2__query_filter_and_select_compose")
		expect(lines).toContain("  row_v2__search_q_narrows_result -.-> row_v2__query_search_and_filter_compose")
		expect(lines).toContain("  row_v2__pagination_page_walk_covers_set --> row_v2__query_filter_selects_from_whole_set")
		expect(lines.filter((line) => line.includes("-->") || line.includes("-.->"))).toHaveLength(1 + 7 + USES.length)
		expect(lines.at(-1)).toBe("  classDef out-of-scope stroke:#3d4758,stroke-dasharray: 2 4")
	})

	it("draws a crowd as its 24 busiest parents and a note", () => {
		/* e1…e29 receive two claims each, e0 one; e59 writes to itself. */
		const lines = mermaidOf(crowd(60, (i) => (i < 59 ? (i + 1) % 30 : 59)))
		expect(lines[0]).toBe("flowchart LR")
		expect(lines[1]).toBe('  e1(("e1 ← 2"))')
		expect(lines[24]).toBe('  e24(("e24 ← 2"))')
		expect(lines.filter((line) => line.includes("(("))).toHaveLength(24)
		expect(lines.at(-1)).toBe('  note["60 entities, compact"]')
	})
})
