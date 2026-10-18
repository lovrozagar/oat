import { describe, expect, it } from "vitest"
import { report, type ReportSpec } from "./__fixtures__/reports.ts"
import { buildMatrixGraph, buildMatrixGraphFromReport } from "./graph.ts"
import { renderMatrixFromParts, renderMatrixHtml, renderPoster } from "./poster.ts"
import { rowsOfReport } from "./rows.ts"

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i}`)
const posterOf = (spec: ReportSpec): string => renderMatrixHtml(report(spec))

describe("renderMatrixHtml", () => {
	it("draws one entity: its name in the title, every chip, its read surface, and no cards", () => {
		const html = posterOf({ entities: [{ name: "table", readSurface: ["GET /table", "GET /t<x>"] }] })
		expect(html.startsWith('<!DOCTYPE html>\n<html lang="en">\n<head>')).toBe(true)
		expect(html).toContain("<title>oat matrix — table</title>")
		expect(html).toContain("<style>\n  :root {")
		expect(html).toContain('<div class="kicker">same fact · many checks</div>')
		expect(html).toContain("<h1>table was asked<br>through independent projections</h1>")
		expect(html).toContain('<div class="passed"><b>57</b><span>passed</span></div>')
		expect(html).not.toContain("out of scope")
		expect(html).not.toContain('<div class="card">')
		expect(html).not.toContain('class="crowd-note"')
		expect(html).toContain('<div class="stage-label">checks — table</div>')
		expect(html).toContain('<span class="chip passed"')
		expect(html).toContain(
			"<div>read surface <code>GET /table</code><span> · </span><code>GET /t&lt;x&gt;</code></div>",
		)
		expect(html).toContain("<div>http://api.test · 2026-10-18T00:00:00.000Z</div>")
		expect(html.endsWith("</article>\n</body>\n</html>\n")).toBe(true)
	})

	it("draws several entities: the claim count, cards, the focus writer, and only the chips that matter", () => {
		const html = posterOf({
			cells: { row: { "patch.minimality": "out-of-scope", "sort.order-is-applied": "failed" } },
			entities: ["table", { name: "row", readSurface: [] }],
			invalidates: [{ routes: ["GET /table"], writer: "row" }],
		})
		expect(html).toContain("<title>oat matrix — table, row</title>")
		expect(html).toContain('<div class="kicker">many entities · invalidate is an edge</div>')
		expect(html).toContain("<h1>2 entities, 1 cross-entity claim</h1>")
		expect(html).toContain('<div class="skipped"><b>1</b><span>out of scope</span></div>')
		expect(html).toContain("out of scope — --ops did not target it")
		expect(html).toContain('<div class="cards"><div class="card">')
		expect(html).toContain('<div class="stage-label">checks — row</div>')
		expect(html.match(/<span class="chip /g)).toHaveLength(1)
		expect(html).toContain("  <footer>\n    <div></div>")
	})

	it("titles a crowd by its size, and draws its forest without cards or strips", () => {
		const html = posterOf({
			entities: names(25),
			invalidates: [
				{ routes: ["GET /e0"], writer: "e1" },
				{ routes: ["GET /e0"], writer: "e2" },
			],
		})
		expect(html).toContain("<title>oat matrix — 25 entities</title>")
		expect(html).toContain("<h1>25 entities, 2 cross-entity claims</h1>")
		expect(html).toContain('<div class="crowd-note">')
		expect(html).toContain('<div class="forest">')
		expect(html).not.toContain('<div class="dots">')
		expect(html).toContain('<div class="strips"></div>')
	})
})

describe("renderPoster and renderMatrixFromParts", () => {
	it("draw the same page as the report the graph came from", () => {
		const input = report({ entities: ["table"] })
		expect(renderPoster(buildMatrixGraphFromReport(input))).toBe(renderMatrixHtml(input))
		const parts = {
			...rowsOfReport(input),
			baseUrl: input.baseUrl,
			entity: "table",
			generatedAt: input.startedAt.toISOString(),
			readSurface: ["GET /table"],
		}
		expect(renderMatrixFromParts(parts)).toBe(renderPoster(buildMatrixGraph(parts)))
		expect(renderMatrixFromParts(parts)).toBe(renderMatrixHtml(input))
	})
})
