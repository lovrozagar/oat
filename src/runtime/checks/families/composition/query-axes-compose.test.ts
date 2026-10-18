import { describe, expect, it } from "vitest"
import { dropping, ignoringPage, losingFirstWhen, PAGED, rejecting } from "./__fixtures__/composition-a.ts"
import { NOTES, queryDoc, stage } from "./__fixtures__/query-api.ts"
import { queryAxesCompose } from "./query-axes-compose.ts"

describe("query.axes-compose judges", () => {
	it("passes a backend whose sorted filter returns the filter's own set", async () => {
		const staged = stage(queryAxesCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ filter: "status.eq.open", limit: 50 },
			{ filter: "status.eq.open", limit: 50, order: "title.desc" },
		])
		expect(staged.findings.findings).toEqual([])
	})

	it("fails a filter dropped once a sort is present: unmatched records appear", async () => {
		const staged = stage(queryAxesCompose, { respond: dropping("filter", ["order"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("adding a sort changes which records a filter returns")
		expect(finding?.detail).toContain('filter on "status" alone matched 3 record(s)')
		expect(finding?.detail).toContain("order=title desc matched 6")
		expect(finding?.detail).toContain("Appeared: n6, n5, n3.")
		expect(finding?.detail).not.toContain("Dropped:")
		expect(finding?.evidence).toHaveLength(2)
	})

	it("fails a sort that drops a matching record", async () => {
		const staged = stage(queryAxesCompose, { respond: losingFirstWhen(["order"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Dropped: n4.")
		expect(staged.findings.findings[0]?.detail).not.toContain("Appeared:")
	})
})

describe("query.axes-compose gives up", () => {
	it("is unresolved when the combined read is refused", async () => {
		const staged = stage(queryAxesCompose, { respond: rejecting(["order"]) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "combining a filter with a sort was rejected, so the two cannot be compared",
		})
	})

	it("is unresolved when a walk never shows the set ended", async () => {
		const staged = stage(queryAxesCompose, { doc: PAGED, respond: ignoringPage() })
		expect(await staged.run()).toMatchObject({
			kind: "unresolved",
			reason: expect.stringContaining("larger than the walk covers"),
		})
	})
})

describe("query.axes-compose plans", () => {
	it("sorts by a field beside the filtered one", () => {
		expect(stage(queryAxesCompose).plan()).toMatchObject({ ok: true, value: { field: "status", sortField: "title" } })
	})

	it("stands down without a filter, an order parameter, a sortable field, or three records", async () => {
		const needs = { kind: "stood-down", reason: "a filterable field, a sortable field, and more than two records" }
		expect(await stage(queryAxesCompose, { doc: queryDoc({}, ["order", "limit"]) }).run()).toEqual(needs)
		expect(await stage(queryAxesCompose, { doc: queryDoc({}, ["filter", "limit"]) }).run()).toEqual(needs)
		expect(await stage(queryAxesCompose, { doc: queryDoc({ sortable: [] }) }).run()).toEqual(needs)
		expect(await stage(queryAxesCompose, { fields: { query: null } }).run()).toEqual(needs)
		const few = stage(queryAxesCompose, { rows: NOTES.slice(0, 2) })
		expect(await few.run()).toEqual(needs)
		expect(few.sent).toEqual([])
	})

	it("stands down with the subset plan's reason when no value selects a proper subset", async () => {
		const rows = NOTES.map((row) => ({ ...row, rank: 1, status: "same" }))
		expect(await stage(queryAxesCompose, { rows }).run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value shared by several cohort records but not all of them",
		})
	})
})
