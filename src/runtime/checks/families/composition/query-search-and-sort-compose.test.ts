import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { MOVING } from "../../query/capabilities.ts"
import { carries, dropWhen, endlessWhen, pagedDoc, rewriting } from "./__fixtures__/composition-b.ts"
import { backend, NOTES, queryDoc, queryOf, REJECT, stage } from "./__fixtures__/query-api.ts"
import { querySearchAndSortCompose } from "./query-search-and-sort-compose.ts"

/* A cohort the first title's whole value finds all of: "memo" in every title. */
const MEMOS = NOTES.map((row, index) => ({ ...row, title: index === 0 ? "memo" : `memo ${String(row["id"])}` }))

/* Sorted by rank, the one sortable field: ranks the cohort holds out of order. */
const BY_RANK = queryDoc({ sortable: ["rank"] })

/* A collection that loses a record on every request: something else is writing to it. */
function shrinking(): Responder {
	let calls = 0
	return (method, path, options) => backend(MEMOS.slice(calls++))(method, path, options)
}

/* The sorted search drops the search; the plain search is refused once it has been answered. */
function refusingRepeat(): Responder {
	let searches = 0
	const dropping = dropWhen("q", "order")
	return (method, path, options) => {
		const query = queryOf(options)
		if (!carries(query, "order") && searches++ > 0) return REJECT
		return dropping(method, path, options)
	}
}

describe("query.search-and-sort-compose judges", () => {
	it("passes a backend whose search holds and stays sorted under an order", async () => {
		const staged = stage(querySearchAndSortCompose, { doc: BY_RANK, rows: MEMOS })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ limit: 50, q: "memo" },
			{ limit: 50, order: "rank.asc", q: "memo" },
			/* An ascending answer is checked against the descending one: a fixed order passes only one. */
			{ limit: 50, order: "rank.desc", q: "memo" },
		])
	})

	it("fails a search dropped when an order is present", async () => {
		const staged = stage(querySearchAndSortCompose, { respond: dropWhen("q", "order") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("adding a sort changes which records a search returns")
		expect(finding?.detail).toBe('q="Alpha report" membership changed when order=title was added.')
		expect(finding?.evidence).toHaveLength(2)
	})

	it("fails an order ignored once a search is present", async () => {
		const staged = stage(querySearchAndSortCompose, { doc: BY_RANK, respond: dropWhen("order", "q"), rows: MEMOS })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: "q + order=rank.asc did not keep rank ascending.",
			summary: "search results are not ordered",
		})
	})
})

describe("query.search-and-sort-compose gives up", () => {
	it("fails an order ignored under a search whose fallback happens to ascend by the sort field", async () => {
		const fixed = rewriting(
			(query) => (carries(query, "q") && carries(query, "order") ? { ...query, order: "rank.asc" } : query),
			MEMOS,
		)
		const staged = stage(querySearchAndSortCompose, { doc: BY_RANK, respond: fixed, rows: MEMOS })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.sent.map((sent) => sent.options.query?.["order"]).filter(Boolean)).toContain("rank.desc")
	})

	it("is unresolved when a read is refused", async () => {
		expect(await stage(querySearchAndSortCompose, { respond: () => REJECT }).run()).toEqual({
			kind: "unresolved",
			reason: "search+sort probe was rejected",
		})
	})

	it("reports a repeat read that is refused as rejected, not as the collection moving", async () => {
		expect(await stage(querySearchAndSortCompose, { respond: refusingRepeat() }).run()).toEqual({
			kind: "unresolved",
			reason: "search+sort probe was rejected",
		})
	})

	it("is unresolved when a read never finishes its walk", async () => {
		const staged = stage(querySearchAndSortCompose, { doc: pagedDoc(), respond: endlessWhen("order") })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "the sets are larger than a read covers" })
	})

	it("is unresolved when the collection moves between the reads", async () => {
		const staged = stage(querySearchAndSortCompose, { respond: shrinking(), rows: MEMOS })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: MOVING })
		expect(staged.findings.findings).toEqual([])
	})
})

describe("query.search-and-sort-compose plans", () => {
	it("searches for a whole cohort value, sorted by a field other than the identity", () => {
		expect(stage(querySearchAndSortCompose).plan()).toEqual({
			ok: true,
			value: { searchField: "title", sortField: "title", token: "Alpha report" },
		})
		expect(stage(querySearchAndSortCompose, { doc: queryDoc({ sortable: ["id"] }) }).plan()).toMatchObject({
			value: { sortField: "id" },
		})
	})

	it("stands down without a search or an order parameter, or without fields for them", () => {
		const noSearch = queryDoc({}, ["filter", "order", "select", "limit"])
		const noOrder = queryDoc({}, ["filter", "select", "q", "limit"])
		for (const doc of [noSearch, noOrder, queryDoc({ searchable: [] }), queryDoc({ sortable: [] })]) {
			expect(stage(querySearchAndSortCompose, { doc }).plan()).toEqual({ ok: false })
		}
	})

	it("stands down without a cohort value long enough to search for", async () => {
		const staged = stage(querySearchAndSortCompose, { rows: NOTES.map((row) => ({ ...row, title: 7 })) })
		expect(await staged.run()).toEqual({
			kind: "stood-down",
			reason: 'a cohort value of "title" long enough to search for',
		})
	})
})
