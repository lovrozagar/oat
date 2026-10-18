import { describe, expect, it } from "vitest"
import { backend } from "./__fixtures__/query-api.ts"
import { dropping, filterAfterPaging, ignoringPage, PAGED, rejecting } from "./__fixtures__/composition-a.ts"
import { NOTES, PARAMS, queryDoc, stage } from "./__fixtures__/query-api.ts"
import { filterAndPagingCompose } from "./query-filter-selects-from-whole-set.ts"

/* Paged, with the identity sortable, so the walks are ordered by it. */
const PAGED_BY_ID = queryDoc({ sortable: ["title", "status", "rank", "score", "id"] }, [...PARAMS, "page"])

/* The cohort with one more open record that carries no identity. */
const ANONYMOUS = [...NOTES, { rank: 5, score: null, status: "open", title: "Nameless" }]

const NEEDS = { kind: "stood-down", reason: "a filterable field and more than two records" }

describe("query.filter-selects-from-whole-set judges", () => {
	it("passes a backend that filters before it pages, walking one row per page", async () => {
		const staged = stage(filterAndPagingCompose, { doc: PAGED })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.every((sent) => sent.options.query?.limit === 1)).toBe(true)
		expect(staged.sent.some((sent) => sent.options.query?.filter === "status.eq.open")).toBe(true)
		expect(staged.sent.some((sent) => sent.options.query?.order !== undefined)).toBe(false)
		expect(staged.findings.findings).toEqual([])
	})

	it("fails a backend that pages before it filters: a later match is never returned", async () => {
		const staged = stage(filterAndPagingCompose, { doc: PAGED, respond: filterAfterPaging() })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("paging a filtered query skips records that match the filter")
		expect(finding?.detail).toContain('filtering client-side on "status" = "open" finds 3 record(s)')
		expect(finding?.detail).toContain("the same filter returns 2. Never returned: n4.")
		expect(finding?.evidence).toHaveLength(2)
	})

	it("walks by the identity where it is sortable", async () => {
		const staged = stage(filterAndPagingCompose, { doc: PAGED_BY_ID })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.every((sent) => sent.options.query?.order === "id.asc")).toBe(true)
	})

	it("walks again unsorted when the sorted walk drops the filter, and judges that walk", async () => {
		const staged = stage(filterAndPagingCompose, { doc: PAGED_BY_ID, respond: dropping("filter", ["order"]) })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		const unsorted = staged.sent.filter((sent) => sent.options.query?.order === undefined)
		expect(unsorted.some((sent) => sent.options.query?.filter === "status.eq.open")).toBe(true)
	})

	it("counts a matching record without an identity as nothing to miss", async () => {
		const staged = stage(filterAndPagingCompose, { doc: PAGED, respond: backend(ANONYMOUS), rows: ANONYMOUS })
		expect(await staged.run()).toEqual({ kind: "asserted" })
	})
})

describe("query.filter-selects-from-whole-set gives up", () => {
	it("is unresolved when the filtered walk is refused, sorted or not", async () => {
		const reason = "the collection could not be walked in both filtered and unfiltered form"
		const sorted = stage(filterAndPagingCompose, { doc: PAGED_BY_ID, respond: rejecting(["filter"]) })
		expect(await sorted.run()).toEqual({ kind: "unresolved", reason })
		const unsorted = stage(filterAndPagingCompose, { doc: PAGED, respond: rejecting(["page"]) })
		expect(await unsorted.run()).toEqual({ kind: "unresolved", reason })
	})

	it("is unresolved when a walk never shows the set ended", async () => {
		const staged = stage(filterAndPagingCompose, { doc: PAGED, respond: ignoringPage() })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the collection is larger than the walk covers, so the two sets are not comparable",
		})
	})

	it("is unresolved when the filter is not applied at all", async () => {
		const staged = stage(filterAndPagingCompose, { doc: PAGED, respond: dropping("filter", []) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the filter was not applied at all, so where it is applied cannot be judged",
		})
	})
})

describe("query.filter-selects-from-whole-set plans", () => {
	it("filters on a proper-subset value and keeps the value to match client-side", () => {
		expect(stage(filterAndPagingCompose).plan()).toEqual({
			ok: true,
			value: { field: "status", target: NOTES[0], term: { filter: "status.eq.open" }, value: "open" },
		})
	})

	it("stands down without a filter or three records", async () => {
		expect(await stage(filterAndPagingCompose, { doc: queryDoc({}, ["order", "limit"]) }).run()).toEqual(NEEDS)
		const few = stage(filterAndPagingCompose, { rows: NOTES.slice(0, 2) })
		expect(await few.run()).toEqual(NEEDS)
		expect(few.sent).toEqual([])
	})

	it("stands down with the subset plan's reason when no value selects a proper subset", async () => {
		const rows = NOTES.map((row) => ({ ...row, rank: 1, status: "same" }))
		expect(await stage(filterAndPagingCompose, { rows }).run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value shared by several cohort records but not all of them",
		})
	})
})
