import { describe, expect, it } from "vitest"
import { report } from "./__fixtures__/reports.ts"
import { checkCatalog, STRIPS } from "./catalog.ts"
import { buildMatrixGraphFromReport } from "./graph.ts"
import { stripHtml } from "./strips.ts"
import type { EntityMatrix } from "./types.ts"

const focus = buildMatrixGraphFromReport(
	report({
		cells: { table: { "query.axes-compose": "blocked", "sort.order-is-applied": "failed" } },
		entities: ["table"],
	}),
).entities[0] as EntityMatrix

describe("stripHtml", () => {
	it("draws every check of one entity as a chip, grouped by strip", () => {
		const html = stripHtml(focus, false)
		expect(html.match(/<div class="strip">/g)).toHaveLength(STRIPS.length)
		expect(html.match(/<span class="chip /g)).toHaveLength(checkCatalog().ids.length)
		expect(html).toContain(
			'<div class="strip"><div class="strip-title">sort</div><div class="chips"><span class="chip failed" title="sort.order-is-applied">order-is-applied</span>',
		)
		expect(html).toContain(
			'<span class="chip blocked" title="query.axes-compose — waiting on filter.equality-selects-exactly-one">axes-compose</span>',
		)
		expect(html).toContain('<span class="chip passed" title="list.read-after-write">read-after-write</span>')
	})

	it("with several entities, keeps only the chips that failed or stood down, and drops empty strips", () => {
		const html = stripHtml(focus, true)
		expect(html.match(/<span class="chip /g)).toHaveLength(2)
		expect(html.match(/<div class="strip">/g)).toHaveLength(2)
		expect(html).not.toContain("chip passed")
	})
})
