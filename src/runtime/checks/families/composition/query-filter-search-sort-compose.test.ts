import { describe, expect, it } from "vitest"
import { dropping, ignoringPage, losingFirstWhen, PAGED, rejecting } from "./__fixtures__/composition-a.ts"
import { NOTES, queryDoc, stage } from "./__fixtures__/query-api.ts"
import { filterSearchSortCompose } from "./query-filter-search-sort-compose.ts"

const NEEDS = {
	kind: "stood-down",
	reason: "a filterable field, a search parameter, a sortable field, and more than two records",
}

describe("query.filter-search-sort-compose judges", () => {
	it("passes a backend whose sort keeps the filter and search intersection", async () => {
		const staged = stage(filterSearchSortCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ filter: "status.eq.open", limit: 50, q: "Alp" },
			{ filter: "status.eq.open", limit: 50, order: "title.desc", q: "Alp" },
		])
	})

	it("fails a filter dropped once a search and a sort join it", async () => {
		const staged = stage(filterSearchSortCompose, { respond: dropping("filter", ["q", "order"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("adding a sort changes which records a filter and a search return")
		expect(finding?.detail).toContain('filter on "status" with q="Alp" matched 1;')
		expect(finding?.detail).toContain("order=title desc matched 2.")
		expect(finding?.detail).toContain("Appeared: n3.")
		expect(finding?.detail).not.toContain("Dropped:")
		expect(finding?.evidence).toHaveLength(2)
	})

	it("fails a search dropped once a sort joins it", async () => {
		const staged = stage(filterSearchSortCompose, { respond: dropping("q", ["order"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Appeared: n4, n2.")
	})

	it("fails a sort that loses a matching record", async () => {
		const staged = stage(filterSearchSortCompose, { respond: losingFirstWhen(["order"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Dropped: n1.")
		expect(staged.findings.findings[0]?.detail).not.toContain("Appeared:")
	})
})

describe("query.filter-search-sort-compose gives up", () => {
	it("is unresolved when the three-way read is refused", async () => {
		const staged = stage(filterSearchSortCompose, { respond: rejecting(["order"]) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "combining a filter, a search and a sort was rejected",
		})
	})

	it("is unresolved when a walk never shows the set ended", async () => {
		const staged = stage(filterSearchSortCompose, { doc: PAGED, respond: ignoringPage() })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "a side of the comparison is larger than the walk covers",
		})
	})
})

describe("query.filter-search-sort-compose plans", () => {
	it("plans an overlapping filter and token with a sort field beside the filtered one", () => {
		expect(stage(filterSearchSortCompose).plan()).toMatchObject({
			ok: true,
			value: { field: "status", sortField: "title", token: "Alp" },
		})
	})

	it("stands down without a filter, a search, an order, searchable or sortable fields, or three records", async () => {
		const docs = [
			queryDoc({}, ["q", "order", "limit"]),
			queryDoc({}, ["filter", "order", "limit"]),
			queryDoc({}, ["filter", "q", "limit"]),
			queryDoc({ searchable: [] }),
			queryDoc({ sortable: [] }),
		]
		for (const doc of docs) expect(await stage(filterSearchSortCompose, { doc }).run()).toEqual(NEEDS)
		expect(await stage(filterSearchSortCompose, { fields: { query: null } }).run()).toEqual(NEEDS)
		const few = stage(filterSearchSortCompose, { rows: NOTES.slice(0, 2) })
		expect(await few.run()).toEqual(NEEDS)
		expect(few.sent).toEqual([])
	})

	it("stands down with the overlap plan's reason when no filter and token overlap", async () => {
		const rows = NOTES.map((row) => ({ ...row, title: "same" }))
		expect(await stage(filterSearchSortCompose, { rows }).run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value and a search token that overlap without nesting",
		})
	})
})
