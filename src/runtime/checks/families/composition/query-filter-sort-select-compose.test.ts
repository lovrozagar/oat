import { describe, expect, it } from "vitest"
import { dropWhen, endlessWhen, fleetingSelect, pagedDoc, rewriting } from "./__fixtures__/composition-b.ts"
import { NOTES, queryDoc, REJECT, stage } from "./__fixtures__/query-api.ts"
import { filterSortSelectCompose } from "./query-filter-sort-select-compose.ts"

/* The triple answered under a narrower filter: one of the filter's records goes missing. */
const narrowedTriple = rewriting((query) =>
	"order" in query && "select" in query ? { ...query, filter: "and(status.eq.open,rank.eq.10)" } : query,
)

/* The triple answered under another filter: records go missing and others appear. */
const swappedTriple = rewriting((query) =>
	"order" in query && "select" in query ? { ...query, filter: "status.eq.closed" } : query,
)

/* The triple refused outright. */
const refusedTriple = rewriting((query) => ("order" in query ? REJECT : query))

/* The triple projected without the identity. */
const anonymousTriple = rewriting((query) => ("order" in query ? { ...query, select: "title" } : query))

describe("query.filter-sort-select-compose judges", () => {
	it("passes a backend whose filter holds under a sort and a select", async () => {
		const staged = stage(filterSortSelectCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ filter: "status.eq.open", limit: 50 },
			{ filter: "status.eq.open", limit: 50, order: "title.desc", select: "id,title" },
		])
		expect(staged.findings.findings).toEqual([])
	})

	it("fails a filter dropped when a sort and a select are both present", async () => {
		const staged = stage(filterSortSelectCompose, { respond: dropWhen("filter", "order", "select") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("adding a sort and a select together changes which records a filter returns")
		expect(finding?.detail).toContain('filter on "status" alone matched 3; the same filter with order=title desc')
		expect(finding?.detail).toContain("matched 6. Appeared: n6, n5, n3.")
		expect(finding?.detail).not.toContain("Dropped:")
		expect(finding?.evidence).toHaveLength(2)
	})

	it("names the records the triple dropped", async () => {
		const staged = stage(filterSortSelectCompose, { respond: narrowedTriple })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Dropped: n2, n4. Each pair composes")
	})

	it("names both the dropped and the appeared records", async () => {
		const staged = stage(filterSortSelectCompose, { respond: swappedTriple })
		await staged.run()
		expect(staged.findings.findings[0]?.detail).toContain("Dropped: n1, n2, n4. Appeared: n5, n3.")
	})
})

describe("query.filter-sort-select-compose gives up", () => {
	it("is unresolved when the triple is refused", async () => {
		const staged = stage(filterSortSelectCompose, { respond: refusedTriple })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "combining a filter with a sort and a select was rejected",
		})
	})

	it("is unresolved when the filter alone is refused", async () => {
		expect(await stage(filterSortSelectCompose, { respond: () => REJECT }).run()).toMatchObject({
			kind: "unresolved",
		})
	})

	it("is unresolved when a side never finishes its walk", async () => {
		const staged = stage(filterSortSelectCompose, { doc: pagedDoc(), respond: endlessWhen("order") })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "a side of the comparison is larger than the walk covers",
		})
	})

	it("is unresolved when the projection omits the identity", async () => {
		const staged = stage(filterSortSelectCompose, { respond: anonymousTriple })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the projected page omitted the identity field, so the two sets cannot be compared",
		})
	})
})

describe("query.filter-sort-select-compose plans", () => {
	it("sorts by a field other than the filtered one, projected beside the identity", () => {
		const plan = stage(filterSortSelectCompose).plan()
		expect(plan).toMatchObject({ ok: true, value: { extra: "title", field: "status", sortField: "title" } })
	})

	it("stands down without a sortable field, a select or more than two records", () => {
		expect(stage(filterSortSelectCompose, { doc: queryDoc({ sortable: [] }) }).plan()).toEqual({ ok: false })
		const noSelect = queryDoc({}, ["filter", "order", "q", "limit"])
		expect(stage(filterSortSelectCompose, { doc: noSelect }).plan()).toEqual({ ok: false })
		const noOrder = queryDoc({}, ["filter", "select", "q", "limit"])
		expect(stage(filterSortSelectCompose, { doc: noOrder }).plan()).toEqual({ ok: false })
		expect(stage(filterSortSelectCompose, { rows: NOTES.slice(0, 2) }).plan()).toEqual({ ok: false })
	})

	it("stands down without a filter value selecting a proper subset", async () => {
		const staged = stage(filterSortSelectCompose, { doc: queryDoc({ filterable: ["title"] }) })
		expect(await staged.run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value shared by several cohort records but not all of them",
		})
		expect(staged.sent).toEqual([])
	})

	it("stands down when the select grammar cannot write the sparse fieldset", () => {
		expect(stage(filterSortSelectCompose, { fields: fleetingSelect() }).plan()).toEqual({
			needs: "a select grammar that can express a sparse fieldset",
			ok: false,
		})
	})
})
