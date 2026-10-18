import { describe, expect, it } from "vitest"
import { report, type ReportSpec } from "./__fixtures__/reports.ts"
import { entityBand } from "./band.ts"
import { buildMatrixGraphFromReport } from "./graph.ts"

const bandOf = (spec: ReportSpec): string => entityBand(buildMatrixGraphFromReport(report(spec)))
const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i}`)

describe("entityBand", () => {
	it("pins a few entities in one row and labels each cross-entity arrow", () => {
		const svg = bandOf({
			entities: [{ name: "table", readSurface: ["GET /table", "GET /table/{id}"] }, "row"],
			invalidates: [{ routes: ["GET /table", "GET /table"], writer: "row" }],
		})
		expect(svg).toContain('<svg viewBox="0 0 1120 172"')
		expect(svg).toContain('<circle cx="373.3333333333333" cy="56" r="16" fill="#f0c14b"/>')
		expect(svg).toContain(">2 read surfaces</text>")
		expect(svg).toContain(">1 read surface</text>")
		expect(svg.match(/<path d="M 746.6666666666666 40 Q 560 20, 373.3333333333333 40"/g)).toHaveLength(1)
		expect(svg).toContain(">row → table</text>")
		expect(svg).not.toContain("no x-invalidate edges")
	})

	it("says why there are no arrows", () => {
		expect(bandOf({ entities: ["table"] })).toContain(">no x-invalidate edges in this document</text>")
		expect(bandOf({ entities: ["table"], invalidates: [{ routes: ["GET /table"], writer: "table" }] })).toContain(
			">invalidate stays on the same entity — the cross-entity check did not apply</text>",
		)
	})

	it("splits up to twelve entities over two rows, and stops labelling arrows past eight", () => {
		const svg = bandOf({ entities: names(9), invalidates: [{ routes: ["GET /e0"], writer: "e8" }] })
		expect(svg).toContain('<svg viewBox="0 0 1120 268"')
		expect(svg).toContain('<path d="M 896 136 Q 541.3333333333334 -8, 186.66666666666666 40"')
		expect(svg).not.toContain("e8 → e0")
	})

	it("lays out thirteen or more entities five to a row", () => {
		expect(bandOf({ entities: names(13) })).toContain('<svg viewBox="0 0 1120 364"')
	})

	it("draws no arrow to or from an entity the run did not test", () => {
		const svg = bandOf({
			entities: ["a", "b", "c"],
			invalidates: [
				{ routes: ["GET /a"], writer: "c" },
				{ routes: ["GET /c"], writer: "a" },
			],
			tested: ["a", "b"],
		})
		expect(svg).not.toMatch(/<path d="M \d/)
		expect(svg).not.toContain("no x-invalidate edges")
	})
})

describe("entityBand of a crowd", () => {
	it("draws a crowd's parents as bars, busiest first, with how many more there are and who has no claim", () => {
		const crowd = names(32)
		const svg = bandOf({
			entities: crowd,
			invalidates: [
				...crowd.slice(0, 30).map((name, i) => ({ routes: [`GET /e${(i + 1) % 30}`], writer: name })),
				{ routes: ["GET /e1"], writer: "e0" },
				{ routes: ["GET /e1"], writer: "e2" },
				{ routes: ["GET /e5"], writer: "e5" },
			],
		})
		expect(svg).toContain(
			'<p class="forest-lead">32 entities · 32 cross-entity claims · 30 parents · 2 with no invalidate edge</p>',
		)
		expect(svg).toContain(
			'<div class="bar-name">e1</div>\n        <div class="bar-track"><div class="bar-fill" style="width:240px">',
		)
		expect(svg).toContain('<div class="bar-n">2 writers</div>')
		expect(svg).toContain('style="width:120px"')
		expect(svg.match(/class="bar-row"/g)).toHaveLength(24)
		expect(svg).toContain('<div class="bar-more">6 more parents</div>')
	})

	it("draws no more line for a crowd with few parents", () => {
		const svg = bandOf({ entities: names(25), invalidates: [{ routes: ["GET /e0"], writer: "e1" }] })
		expect(svg).toContain("25 entities · 1 cross-entity claims · 1 parents · 23 with no invalidate edge")
		expect(svg).not.toContain("bar-more")
	})
})
