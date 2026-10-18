import { describe, expect, it } from "vitest"
import { dropWhen, endlessWhen, pagedDoc, rewriting } from "./__fixtures__/composition-b.ts"
import { NOTES, queryDoc, REJECT, stage } from "./__fixtures__/query-api.ts"
import { searchAndFilterCompose } from "./query-search-and-filter-compose.ts"

/* The filter plus search answered under another filter: n1 goes missing and n3 appears. */
const swappedBoth = rewriting((query) =>
	"q" in query && "filter" in query ? { ...query, filter: "status.eq.closed" } : query,
)

/* The filter plus search answered as nothing. */
const emptiedBoth = rewriting((query) =>
	"q" in query && "filter" in query ? { ...query, filter: "status.eq.none" } : query,
)

/* The filter alone refused. */
const refusedFilter = rewriting((query) => ("filter" in query && !("q" in query) ? REJECT : query))

/* Every search refused. */
const refusedSearch = rewriting((query) => ("q" in query ? REJECT : query))

describe("query.search-and-filter-compose judges", () => {
	it("passes a backend whose filter and search compose as their intersection", async () => {
		const staged = stage(searchAndFilterCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ filter: "status.eq.open", limit: 50 },
			{ limit: 50, q: "Alp" },
			{ filter: "status.eq.open", limit: 50, q: "Alp" },
		])
		expect(staged.findings.findings).toEqual([])
	})

	it("fails a filter dropped when a search is present", async () => {
		const staged = stage(searchAndFilterCompose, { respond: dropWhen("filter", "q") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("a filter and a search do not compose as their intersection")
		expect(finding?.detail).toContain(
			'filter on "status" matched 3; q="Alp" matched 2; both together matched 2 (intersection is 1). Extra: n3.',
		)
		expect(finding?.detail).not.toContain("Missing:")
		expect(finding?.evidence).toHaveLength(3)
	})

	it("fails a search dropped when a filter is present", async () => {
		const staged = stage(searchAndFilterCompose, { respond: dropWhen("q", "filter") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain("Extra: n2, n4.")
	})

	it("names the records the combination is missing", async () => {
		const missing = stage(searchAndFilterCompose, { respond: emptiedBoth })
		await missing.run()
		expect(missing.findings.findings[0]?.detail).toContain("(intersection is 1). Missing: n1. A structured")
		const swapped = stage(searchAndFilterCompose, { respond: swappedBoth })
		await swapped.run()
		expect(swapped.findings.findings[0]?.detail).toContain("Missing: n1. Extra: n3.")
	})
})

describe("query.search-and-filter-compose gives up", () => {
	it("is unresolved when the filter alone is refused", async () => {
		const staged = stage(searchAndFilterCompose, { respond: refusedFilter })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the filtered listing was rejected, so it cannot be compared with a search",
		})
		expect(staged.sent).toHaveLength(1)
	})

	it("is unresolved when the filtered set never finishes its walk", async () => {
		const staged = stage(searchAndFilterCompose, { doc: pagedDoc(), respond: endlessWhen("filter") })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the filtered set is larger than the walk covers",
		})
	})

	it("is unresolved when a search is refused", async () => {
		const staged = stage(searchAndFilterCompose, { respond: refusedSearch })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "combining a filter with a search was rejected, so the two cannot be compared",
		})
	})

	it("is unresolved when a search never finishes its walk", async () => {
		const staged = stage(searchAndFilterCompose, { doc: pagedDoc(), respond: endlessWhen("q") })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "a side of the comparison is larger than the walk covers",
		})
	})
})

describe("query.search-and-filter-compose plans", () => {
	it("picks a filter value and a token that overlap without nesting", () => {
		expect(stage(searchAndFilterCompose).plan()).toMatchObject({
			ok: true,
			value: { field: "status", term: { filter: "status.eq.open" }, token: "Alp" },
		})
	})

	it("stands down without a search parameter, searchable fields or more than two records", () => {
		const noSearch = queryDoc({}, ["filter", "order", "select", "limit"])
		expect(stage(searchAndFilterCompose, { doc: noSearch }).plan()).toEqual({ ok: false })
		expect(stage(searchAndFilterCompose, { doc: queryDoc({ searchable: [] }) }).plan()).toEqual({ ok: false })
		expect(stage(searchAndFilterCompose, { rows: NOTES.slice(0, 2) }).plan()).toEqual({ ok: false })
	})

	it("stands down without a filter value and token that overlap", async () => {
		const staged = stage(searchAndFilterCompose, { doc: queryDoc({ filterable: ["title"] }) })
		expect(await staged.run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value and a search token that overlap without nesting",
		})
		expect(staged.sent).toEqual([])
	})
})
