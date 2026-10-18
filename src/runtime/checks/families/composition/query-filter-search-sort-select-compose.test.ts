import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import {
	dropping,
	ignoringPage,
	PAGED,
	rejecting,
	switchingAfter,
	withoutIdentityWhen,
} from "./__fixtures__/composition-a.ts"
import { backend, NOTES, queryDoc, REJECT, stage } from "./__fixtures__/query-api.ts"
import { queryFilterSearchSortSelectCompose } from "./query-filter-search-sort-select-compose.ts"

const NEEDS = { kind: "stood-down", reason: "all four list axes declared and at least three records" }

/* The filter dropped only when all four axes are present: no pair or triple shows it. */
const DROPPED_WITH_ALL_FOUR = dropping("filter", ["q", "order", "select"])

/* Another open record matching the token, written between the first reads and the re-reads. */
const GROWN = backend([...NOTES, { id: "n7", rank: 4, score: 2, status: "open", title: "Alpine" }])

const refusingAll: Responder = () => REJECT

describe("query.filter-search-sort-select-compose judges", () => {
	it("passes a backend whose four-axis listing keeps the filter and search intersection", async () => {
		const staged = stage(queryFilterSearchSortSelectCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ filter: "status.eq.open", limit: 50, q: "Alp" },
			{ filter: "status.eq.open", limit: 50, order: "title.asc", q: "Alp", select: "id,title" },
		])
	})

	it("fails a filter dropped only when all four axes meet, after reading both sides again", async () => {
		const staged = stage(queryFilterSearchSortSelectCompose, { respond: DROPPED_WITH_ALL_FOUR })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("filter ∩ search membership changes when sort and select join")
		expect(finding?.detail).toBe("the four-axis listing returned 2; filter+search alone returned 1.")
		expect(finding?.evidence).toHaveLength(2)
		expect(staged.sent).toHaveLength(4)
	})
})

describe("query.filter-search-sort-select-compose gives up", () => {
	it("is unresolved when the four-axis read is refused", async () => {
		const staged = stage(queryFilterSearchSortSelectCompose, { respond: rejecting(["select"]) })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "four-axis probe was rejected" })
	})

	it("is unresolved when a re-read is refused", async () => {
		const respond = switchingAfter(2, refusingAll, DROPPED_WITH_ALL_FOUR)
		const staged = stage(queryFilterSearchSortSelectCompose, { respond })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "four-axis probe was rejected" })
	})

	it("is unresolved when the collection moved between the reads", async () => {
		const respond = switchingAfter(2, GROWN, DROPPED_WITH_ALL_FOUR)
		const staged = stage(queryFilterSearchSortSelectCompose, { respond })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("gained or lost") })
		expect(staged.findings.findings).toEqual([])
	})

	it("is unresolved when a walk never shows the set ended", async () => {
		const staged = stage(queryFilterSearchSortSelectCompose, { doc: PAGED, respond: ignoringPage() })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "a side of the comparison is larger than the walk covers",
		})
	})

	it("is unresolved when the projection leaves out the identity", async () => {
		const staged = stage(queryFilterSearchSortSelectCompose, { respond: withoutIdentityWhen(["select"]) })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "projection omitted the identity" })
	})
})

describe("query.filter-search-sort-select-compose plans", () => {
	it("plans the overlap, a sort beside the identity, and the identity with one more field", () => {
		expect(stage(queryFilterSearchSortSelectCompose).plan()).toMatchObject({
			ok: true,
			value: { projection: { select: "id,title" }, requested: ["id", "title"], sortField: "title", token: "Alp" },
		})
	})

	it("selects and sorts by the identity alone when nothing else is declared", () => {
		const doc = queryDoc({ selectable: ["id"], sortable: ["id"] })
		expect(stage(queryFilterSearchSortSelectCompose, { doc }).plan()).toMatchObject({
			ok: true,
			value: { projection: { select: "id" }, requested: ["id"], sortField: "id" },
		})
	})

	it("stands down without any of the four axes, selectable or sortable fields, or three records", async () => {
		const docs = [
			queryDoc({}, ["q", "order", "select", "limit"]),
			queryDoc({}, ["filter", "order", "select", "limit"]),
			queryDoc({}, ["filter", "q", "select", "limit"]),
			queryDoc({}, ["filter", "q", "order", "limit"]),
			queryDoc({ selectable: [] }),
			queryDoc({ sortable: [] }),
		]
		for (const doc of docs) expect(await stage(queryFilterSearchSortSelectCompose, { doc }).run()).toEqual(NEEDS)
		expect(await stage(queryFilterSearchSortSelectCompose, { fields: { query: null } }).run()).toEqual(NEEDS)
		const few = stage(queryFilterSearchSortSelectCompose, { rows: NOTES.slice(0, 2) })
		expect(await few.run()).toEqual(NEEDS)
		expect(few.sent).toEqual([])
	})

	it("stands down with the overlap plan's reason when no filter and token overlap", async () => {
		const rows = NOTES.map((row) => ({ ...row, title: "same" }))
		expect(await stage(queryFilterSearchSortSelectCompose, { rows }).run()).toEqual({
			kind: "stood-down",
			reason: "a filterable value and a search token that overlap without nesting",
		})
	})
})
