import { describe, expect, it } from "vitest"
import { report } from "./__fixtures__/reports.ts"
import { checkCatalog } from "./catalog.ts"
import { buildMatrixGraphFromReport } from "./graph.ts"
import { reportRows, rowsOfReport } from "./rows.ts"
import { entitySlice, focusOf, nodeOf } from "./slice.ts"
import type { MatrixReport } from "./types.ts"

const catalog = checkCatalog()
const table = { identity: "id", name: "table", readSurface: ["GET /table"] }
const sliceOf = (from: MatrixReport) => entitySlice(table, catalog, reportRows(rowsOfReport(from)))

const input = report({
	cells: {
		table: {
			"patch.minimality": "out-of-scope",
			"query.axes-compose": "blocked",
			"search.q-narrows-result": "skipped",
			"sort.order-is-applied": "failed",
		},
	},
	checksRun: catalog.ids.filter((id) => id !== "select.projection-honoured"),
	entities: ["table"],
	findings: [
		{ check: "filter.or-composes-as-union", entity: "table", summary: "gap", verdict: "COVERAGE_GAP" },
		{
			check: "filter.and-composes-as-intersection",
			entity: "table",
			origin: "staging",
			summary: "s",
			verdict: "BACKEND_BUG",
		},
	],
})
const slice = sliceOf(input)

describe("entitySlice", () => {
	it("gives each catalogued check the status the report gave it", () => {
		expect(slice.nodes.map((node) => node.id)).toEqual(catalog.ids)
		const status = (id: string) => nodeOf(slice, id).status
		expect(status("sort.order-is-applied")).toBe("failed")
		expect(status("query.axes-compose")).toBe("blocked")
		expect(status("search.q-narrows-result")).toBe("skipped")
		expect(status("patch.minimality")).toBe("out-of-scope")
		expect(status("select.projection-honoured")).toBe("skipped")
		expect(status("list.read-after-write")).toBe("passed")
		expect(slice.counts).toEqual({
			blocked: 1,
			failed: 1,
			"out-of-scope": 1,
			passed: catalog.ids.length - 5,
			skipped: 2,
		})
		expect(slice).toMatchObject({ identity: "id", name: "table", readSurface: ["GET /table"] })
	})

	it("records the group, layer, needs, cause and primary finding of a check", () => {
		expect(nodeOf(slice, "query.axes-compose")).toEqual({
			because: "filter.equality-selects-exactly-one",
			group: "composition",
			id: "query.axes-compose",
			layer: "composition",
			needs: catalog.needs.get("query.axes-compose"),
			status: "blocked",
		})
		const needless = entitySlice(table, { ...catalog, needs: new Map() }, reportRows(rowsOfReport(input)))
		expect(nodeOf(needless, "query.axes-compose")).not.toHaveProperty("needs")
		expect(nodeOf(slice, "sort.order-is-applied")).toMatchObject({
			summary: "sort.order-is-applied disagreed",
			verdict: "BACKEND_BUG",
		})
	})

	it("does not fail a check on a coverage gap or on another origin's finding", () => {
		expect(nodeOf(slice, "filter.or-composes-as-union")).toMatchObject({
			status: "passed",
			summary: "gap",
			verdict: "COVERAGE_GAP",
		})
		const secondary = nodeOf(slice, "filter.and-composes-as-intersection")
		expect(secondary.status).toBe("passed")
		expect(secondary).not.toHaveProperty("verdict")
	})

	it("roots the failures no earlier failure explains", () => {
		const failing = sliceOf(
			report({
				cells: { table: { "create.persists-submitted-fields": "failed", "list.read-after-write": "failed" } },
				entities: ["table"],
			}),
		)
		expect(failing.roots).toEqual(["list.read-after-write"])
	})
})

const graphOf = (invalidates: Array<{ writer: string; routes: string[] }>) =>
	buildMatrixGraphFromReport(report({ entities: ["table", "row"], invalidates }))

describe("focusOf", () => {
	it("picks the first entity whose writes reach another entity", () => {
		const graph = graphOf([{ routes: ["GET /table"], writer: "row" }])
		expect(focusOf(graph.entities, graph.invalidate).name).toBe("row")
	})

	it("falls back to the first entity when no write crosses", () => {
		const graph = graphOf([{ routes: ["GET /row"], writer: "row" }])
		expect(focusOf(graph.entities, graph.invalidate).name).toBe("table")
	})
})
