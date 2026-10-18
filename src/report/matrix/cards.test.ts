import { describe, expect, it } from "vitest"
import { report, type ReportSpec } from "./__fixtures__/reports.ts"
import { entityCards, forestSummary } from "./cards.ts"
import { NODE_ORDER } from "./catalog.ts"
import { buildMatrixGraphFromReport } from "./graph.ts"

const graphOf = (spec: ReportSpec) => buildMatrixGraphFromReport(report(spec))
const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i}`)

describe("entityCards", () => {
	it("gives each entity its identity, surfaces, the entities it invalidates, and a dot per poster cell", () => {
		const html = entityCards(
			graphOf({
				cells: { row: { "sort.order-is-applied": "failed" } },
				entities: [{ identity: "id", name: "table" }, "row"],
				invalidates: [{ routes: ["GET /table", "GET /table"], writer: "row" }],
			}),
		)
		expect(html.startsWith('<div class="cards"><div class="card">')).toBe(true)
		expect(html).toContain('<div class="meta">id table.id · 1 surfaces · does not invalidate another entity</div>')
		expect(html).toContain('<div class="meta">no identity · 1 surfaces · invalidates table</div>')
		expect(html.match(/<span class="dot /g)).toHaveLength(2 * NODE_ORDER.length)
		expect(html).toContain('<span class="dot failed" title="sort"></span>')
	})
})

describe("forestSummary", () => {
	it("shows every entity that disagreed and up to eight that only stood down", () => {
		const blocked = Object.fromEntries(
			names(12)
				.slice(2)
				.map((name) => [name, { "query.axes-compose": "blocked" as const }]),
		)
		const html = forestSummary(
			graphOf({
				cells: { ...blocked, e0: { "list.read-after-write": "failed" } },
				entities: names(30),
				invalidates: [{ routes: ["GET /e1"], writer: "e0" }],
			}),
		)
		expect(html).toContain("    19 entities passed every check that applied.\n    Showing 1 entities that disagreed.")
		expect(html).toContain('<div class="meta">1 disagreed · 0 stood down · invalidates e1</div>')
		expect(html).toContain('<div class="meta">0 disagreed · 1 stood down · does not invalidate another entity</div>')
		expect(html.match(/<div class="card">/g)).toHaveLength(9)
	})

	it("says it shows one writer, and draws no cards, when nothing disagreed or stood down", () => {
		const html = forestSummary(graphOf({ entities: names(30) }))
		expect(html).toContain("Showing the detail view for one writer, not all 200 entities.")
		expect(html).not.toContain('<div class="cards">')
	})
})
