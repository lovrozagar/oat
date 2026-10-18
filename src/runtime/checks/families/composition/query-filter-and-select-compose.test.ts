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
import { filterAndSelectCompose } from "./query-filter-and-select-compose.ts"

describe("query.filter-and-select-compose judges", () => {
	it("passes a backend whose projected filter returns the filter's own set", async () => {
		const staged = stage(filterAndSelectCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ filter: "status.eq.open", limit: 50 },
			{ filter: "status.eq.open", limit: 50, select: "id,title" },
		])
		expect(staged.findings.findings).toEqual([])
	})

	it("fails a filter dropped once a select is present: unmatched records appear", async () => {
		const staged = stage(filterAndSelectCompose, { respond: dropping("filter", ["select"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("adding a select changes which records a filter returns")
		expect(finding?.detail).toContain('filter on "status" alone matched 3 record(s)')
		expect(finding?.detail).toContain("select=id,title matched 6")
		expect(finding?.detail).toContain("Appeared: n3, n5, n6.")
		expect(finding?.detail).not.toContain("Dropped:")
		expect(finding?.evidence).toHaveLength(2)
	})

	it("fails a select that drops a matching record", async () => {
		const staged = stage(filterAndSelectCompose, { respond: losingFirstWhen(["select"]) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Dropped: n1.")
		expect(staged.findings.findings[0]?.detail).not.toContain("Appeared:")
	})
})

describe("query.filter-and-select-compose gives up", () => {
	it("is unresolved when the combined read is refused", async () => {
		const staged = stage(filterAndSelectCompose, { respond: rejecting(["select"]) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "combining a filter with a select was rejected, so the two cannot be compared",
		})
	})

	it("is unresolved when a walk never shows the set ended", async () => {
		const staged = stage(filterAndSelectCompose, { doc: PAGED, respond: ignoringPage() })
		expect(await staged.run()).toMatchObject({ reason: expect.stringContaining("larger than the walk covers") })
	})

	it("is unresolved when the projection leaves out the identity", async () => {
		const staged = stage(filterAndSelectCompose, { respond: withoutIdentityWhen(["select"]) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the projected page omitted the identity field, so the two sets cannot be compared",
		})
		expect(staged.findings.findings).toEqual([])
	})
})

describe("query.filter-and-select-compose plans", () => {
	it("projects the identity and a field beside it over a proper-subset filter", () => {
		expect(stage(filterAndSelectCompose).plan()).toEqual({
			ok: true,
			value: {
				extra: "title",
				field: "status",
				projection: { select: "id,title" },
				target: NOTES[0],
				term: { filter: "status.eq.open" },
			},
		})
	})

	it("stands down without a filter, a select parameter, or three records", async () => {
		const needs = { kind: "stood-down", reason: "a filterable field, a select parameter, and more than two records" }
		expect(await stage(filterAndSelectCompose, { doc: queryDoc({}, ["select", "limit"]) }).run()).toEqual(needs)
		expect(await stage(filterAndSelectCompose, { doc: queryDoc({}, ["filter", "limit"]) }).run()).toEqual(needs)
		const few = stage(filterAndSelectCompose, { rows: NOTES.slice(0, 2) })
		expect(await few.run()).toEqual(needs)
		expect(few.sent).toEqual([])
	})

	it("stands down with the subset plan's reason when no value selects a proper subset", async () => {
		const rows = NOTES.map((row) => ({ ...row, rank: 1, status: "same" }))
		expect(await stage(filterAndSelectCompose, { rows }).run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value shared by several cohort records but not all of them",
		})
	})
})
