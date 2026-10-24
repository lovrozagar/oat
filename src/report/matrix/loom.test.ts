import { describe, expect, it } from "vitest"
import { report } from "./__fixtures__/reports.ts"
import { buildMatrixGraphFromReport } from "./graph.ts"
import { loomSvg } from "./loom.ts"
import type { EntityMatrix } from "./types.ts"

const svg = loomSvg(
	buildMatrixGraphFromReport(
		report({
			cells: {
				"a&b": {
					"query.axes-compose": "blocked",
					"query.filter-and-select-compose": "out-of-scope",
					"search.q-narrows-result": "skipped",
					"sort.order-is-applied": "failed",
				},
			},
			entities: ["a&b"],
		}),
	).entities[0] as EntityMatrix,
)

describe("loomSvg", () => {
	it("names the cohort and draws a station for each poster cell", () => {
		expect(svg).toContain('aria-label="Query checks for a&amp;b"')
		expect(svg).toContain('font-weight="700">a&amp;b</text>')
		expect(svg.match(/<g>/g)).toHaveLength(15)
	})

	it("ties each read and axis to the cohort, and each composition to its parts, in the status's color", () => {
		expect(svg).toContain('<line x1="130" y1="270" x2="130" y2="70" stroke="#7dcea0" stroke-width="1.6" />')
		expect(svg).toContain('<line x1="130" y1="270" x2="390" y2="180" stroke="#ff6b3d" stroke-width="1.6" />')
		expect(svg).toContain(
			'<line x1="130" y1="270" x2="390" y2="360" stroke="#3d4758" stroke-width="1.6" stroke-dasharray="5 5"/>',
		)
		expect(svg).toContain(
			'<line x1="390" y1="90" x2="700" y2="110" stroke="#6d7686" stroke-width="1.6" stroke-dasharray="5 5"/>',
		)
		expect(svg).toContain(
			'<line x1="390" y1="90" x2="700" y2="220" stroke="#3d4758" stroke-width="1.6" stroke-dasharray="5 5"/>',
		)
		expect(svg.match(/<line /g)).toHaveLength(8 + 14)
	})

	it("captions a station with its hint, `disagreed`, or nothing while it stood down", () => {
		expect(svg).toContain(
			'<rect x="344" y="165" width="92" height="30" rx="2" fill="#ff6b3d" stroke="#ff6b3d" />\n    <text x="390" y="185" text-anchor="middle" fill="#243044"',
		)
		expect(svg).toContain('font-family="IBM Plex Mono, monospace">disagreed</text>')
		expect(svg).toContain('fill="#7dcea0" font-size="12" font-family="Syne, sans-serif" font-weight="700">list</text>')
		expect(svg).toContain('font-family="IBM Plex Mono, monospace">create then list</text>')
		expect(svg).toContain(
			'<rect x="640.9" y="95" width="118.2" height="30" rx="2" fill="#1b2332" stroke="#6d7686" stroke-dasharray="3 3"/>',
		)
		expect(svg).toContain('font-weight="700">filter + sort</text>\n    \n  </g>')
		expect(svg).toContain(
			'<rect x="633.5" y="205" width="133" height="30" rx="2" fill="#1b2332" stroke="#3d4758" stroke-dasharray="3 3"/>',
		)
	})
})
