import { describe, expect, it } from "vitest"
import {
	dropping,
	ignoringPage,
	losingFirstWhen,
	PAGED,
	rejecting,
	withoutIdentityWhen,
} from "./__fixtures__/composition-a.ts"
import { NOTES, queryDoc, stage } from "./__fixtures__/query-api.ts"
import { filterSearchSelectCompose } from "./query-filter-search-select-compose.ts"

const NEEDS = {
	kind: "stood-down",
	reason: "a filterable field, a search parameter, a select parameter, and more than two records",
}

describe("query.filter-search-select-compose judges", () => {
	it("passes a backend whose projection keeps the filter and search intersection", async () => {
		const staged = stage(filterSearchSelectCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ filter: "status.eq.open", limit: 50, q: "Alp" },
			{ filter: "status.eq.open", limit: 50, q: "Alp", select: "id,title" },
		])
	})

	it("fails a filter dropped once a search and a select join it", async () => {
		const staged = stage(filterSearchSelectCompose, { respond: dropping("filter", ["q", "select"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("adding a select changes which records a filter and a search return")
		expect(finding?.detail).toContain('filter on "status" with q="Alp" matched 1;')
		expect(finding?.detail).toContain("select=id,title matched 2.")
		expect(finding?.detail).toContain("Appeared: n3.")
		expect(finding?.detail).not.toContain("Dropped:")
		expect(finding?.evidence).toHaveLength(2)
	})

	it("fails a search dropped once a select joins it: the matching record is lost", async () => {
		const staged = stage(filterSearchSelectCompose, { respond: losingFirstWhen(["select"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Dropped: n1.")
		expect(staged.findings.findings[0]?.detail).not.toContain("Appeared:")
	})

	it("fails a search dropped once a select joins it: the filter's other records appear", async () => {
		const staged = stage(filterSearchSelectCompose, { respond: dropping("q", ["select"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Appeared: n2, n4.")
	})
})

describe("query.filter-search-select-compose gives up", () => {
	it("is unresolved when the three-way read is refused", async () => {
		const staged = stage(filterSearchSelectCompose, { respond: rejecting(["select"]) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "combining a filter, a search and a select was rejected",
		})
	})

	it("is unresolved when a walk never shows the set ended", async () => {
		const staged = stage(filterSearchSelectCompose, { doc: PAGED, respond: ignoringPage() })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "a side of the comparison is larger than the walk covers",
		})
	})

	it("is unresolved when the projection leaves out the identity", async () => {
		const staged = stage(filterSearchSelectCompose, { respond: withoutIdentityWhen(["select"]) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the projected page omitted the identity field, so the two sets cannot be compared",
		})
	})
})

describe("query.filter-search-select-compose plans", () => {
	it("plans an overlapping filter and token with a projection beside the identity", () => {
		expect(stage(filterSearchSelectCompose).plan()).toMatchObject({
			ok: true,
			value: { extra: "title", field: "status", projection: { select: "id,title" }, token: "Alp" },
		})
	})

	it("stands down without a filter, a search, a select, searchable fields, or three records", async () => {
		const docs = [
			queryDoc({}, ["q", "select", "limit"]),
			queryDoc({}, ["filter", "select", "limit"]),
			queryDoc({}, ["filter", "q", "limit"]),
			queryDoc({ searchable: [] }),
		]
		for (const doc of docs) expect(await stage(filterSearchSelectCompose, { doc }).run()).toEqual(NEEDS)
		expect(await stage(filterSearchSelectCompose, { fields: { query: null } }).run()).toEqual(NEEDS)
		const few = stage(filterSearchSelectCompose, { rows: NOTES.slice(0, 2) })
		expect(await few.run()).toEqual(NEEDS)
		expect(few.sent).toEqual([])
	})

	it("stands down with the overlap plan's reason when no filter and token overlap", async () => {
		const rows = NOTES.map((row) => ({ ...row, title: "same" }))
		expect(await stage(filterSearchSelectCompose, { rows }).run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value and a search token that overlap without nesting",
		})
	})
})
