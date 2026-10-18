import { describe, expect, it } from "vitest"
import { indexRows, onPrimary, reportRows, rowsFor, rowsOfReport } from "./rows.ts"
import type { MatrixReport } from "./types.ts"

const report: MatrixReport = {
	baseUrl: "http://api.test",
	checksRun: ["sort.order-is-applied"],
	entitiesTested: ["table"],
	findings: [{ check: "sort.order-is-applied", entity: "table", summary: "s", verdict: "BACKEND_BUG" }],
	model: { byRoute: new Map(), entities: new Map(), operations: [] },
	startedAt: new Date(0),
}

describe("rowsOfReport", () => {
	it("reads a list the report left out as empty", () => {
		expect(rowsOfReport(report)).toEqual({
			checksOutOfScope: [],
			checksRun: ["sort.order-is-applied"],
			checksSkipped: [],
			checksSuppressed: [],
			findings: report.findings,
		})
	})

	it("keeps the lists the report has", () => {
		const skipped = [{ check: "a.b", entity: "table", needs: "n" }]
		const suppressed = [{ because: "x.y", check: "a.b", entity: "table" }]
		const outOfScope = [{ check: "a.b", entity: "table" }]
		const rows = rowsOfReport({
			...report,
			checksOutOfScope: outOfScope,
			checksSkipped: skipped,
			checksSuppressed: suppressed,
		})
		expect(rows).toMatchObject({ checksOutOfScope: outOfScope, checksSkipped: skipped, checksSuppressed: suppressed })
	})
})

describe("reportRows", () => {
	it("indexes every list and the checks that ran; parts without out-of-scope rows have none", () => {
		const rows = reportRows({ ...rowsOfReport(report), checksOutOfScope: undefined as never })
		expect(rows.ran.has("sort.order-is-applied")).toBe(true)
		expect(rowsFor(rows.findings, "sort.order-is-applied", "table")).toEqual(report.findings)
		expect(rowsFor(rows.outOfScope, "sort.order-is-applied", "table")).toEqual([])
		const { checksOutOfScope: _, ...withoutScope } = rowsOfReport(report)
		expect(rowsFor(reportRows(withoutScope).outOfScope, "sort.order-is-applied", "table")).toEqual([])
	})
})

describe("rowsFor", () => {
	const rows = [
		{ check: "c", entity: "table", n: 0 },
		{ check: "c", n: 1 },
		{ check: "c", entity: "table · fixture", n: 2 },
		{ check: "c", entity: "table.title", n: 3 },
		{ check: "c", entity: "tables", n: 4 },
		{ check: "c", entity: "a", n: 5 },
		{ check: "c", entity: "a.b.c", n: 6 },
		{ check: "d", entity: "table", n: 7 },
	]
	const index = indexRows(rows)
	const ns = (check: string, entity: string): number[] => rowsFor(index, check, entity).map((row) => row.n)

	it("finds an entity's rows by fixture and field, and rows naming no entity, in report order", () => {
		expect(ns("c", "table")).toEqual([0, 1, 2, 3])
	})

	it("returns only the entity's own rows when every row names an entity", () => {
		expect(ns("d", "table")).toEqual([7])
	})

	it("gives an entity with no rows of its own the rows naming no entity", () => {
		expect(ns("c", "chair")).toEqual([1])
	})

	it("keeps a dotted entity's rows apart from the entity its name starts with", () => {
		expect(ns("c", "a.b")).toEqual([1, 6])
		expect(ns("c", "a")).toEqual([1, 5, 6])
	})

	it("has nothing for a check no row is about", () => {
		expect(ns("e", "table")).toEqual([])
	})
})

describe("onPrimary", () => {
	it("is true for a finding with no origin or the primary's empty one", () => {
		expect(onPrimary({})).toBe(true)
		expect(onPrimary({ origin: "" })).toBe(true)
		expect(onPrimary({ origin: "staging" })).toBe(false)
	})
})
