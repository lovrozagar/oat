import { describe, expect, it } from "vitest"
import { dropWhen, endlessWhen, fleetingSelect, pagedDoc, rewriting } from "./__fixtures__/composition-b.ts"
import { NOTES, queryDoc, REJECT, stage } from "./__fixtures__/query-api.ts"
import { querySearchAndSelectCompose } from "./query-search-and-select-compose.ts"

/* The projected search refused. */
const refusedProjection = rewriting((query) => ("select" in query ? REJECT : query))

/* The projected search answered without the identity. */
const anonymousProjection = rewriting((query) => ("select" in query ? { ...query, select: "title" } : query))

describe("query.search-and-select-compose judges", () => {
	it("passes a backend whose search holds under a select", async () => {
		const staged = stage(querySearchAndSelectCompose)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ limit: 50, q: "Alpha report" },
			{ limit: 50, q: "Alpha report", select: "id,title" },
		])
	})

	it("fails a search dropped when a select is present", async () => {
		const staged = stage(querySearchAndSelectCompose, { respond: dropWhen("q", "select") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("adding a select changes which records a search returns")
		expect(finding?.detail).toBe('q="Alpha report" alone matched 1; with select it matched 6.')
		expect(finding?.evidence).toHaveLength(2)
	})
})

describe("query.search-and-select-compose gives up", () => {
	it("is unresolved when either read is refused", async () => {
		const reason = { kind: "unresolved", reason: "search+select probe was rejected" }
		expect(await stage(querySearchAndSelectCompose, { respond: refusedProjection }).run()).toEqual(reason)
		expect(await stage(querySearchAndSelectCompose, { respond: () => REJECT }).run()).toEqual(reason)
	})

	it("is unresolved when a read never finishes its walk", async () => {
		const staged = stage(querySearchAndSelectCompose, { doc: pagedDoc(), respond: endlessWhen("select") })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "the sets are larger than a read covers" })
	})

	it("is unresolved when the projection omits the identity", async () => {
		const staged = stage(querySearchAndSelectCompose, { respond: anonymousProjection })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "projection omitted the identity" })
	})
})

describe("query.search-and-select-compose plans", () => {
	it("searches for a whole cohort value and projects the searched field beside the identity", () => {
		expect(stage(querySearchAndSelectCompose).plan()).toEqual({
			ok: true,
			value: { field: "title", projection: { select: "id,title" }, requested: ["id", "title"], token: "Alpha report" },
		})
	})

	it("stands down without a search or a select parameter", () => {
		const noSearch = queryDoc({}, ["filter", "order", "select", "limit"])
		expect(stage(querySearchAndSelectCompose, { doc: noSearch }).plan()).toEqual({ ok: false })
		const noSelect = queryDoc({}, ["filter", "order", "q", "limit"])
		expect(stage(querySearchAndSelectCompose, { doc: noSelect }).plan()).toEqual({ ok: false })
	})

	it("stands down without searchable or selectable fields", () => {
		expect(stage(querySearchAndSelectCompose, { fields: { query: null } }).plan()).toEqual({ ok: false })
		expect(stage(querySearchAndSelectCompose, { doc: queryDoc({ searchable: [] }) }).plan()).toEqual({ ok: false })
		expect(stage(querySearchAndSelectCompose, { doc: queryDoc({ selectable: [] }) }).plan()).toEqual({ ok: false })
	})

	it("stands down without a cohort value long enough to search for", async () => {
		const rows = NOTES.map((row) => ({ ...row, title: "ab" }))
		const staged = stage(querySearchAndSelectCompose, { rows })
		expect(await staged.run()).toEqual({
			kind: "stood-down",
			reason: 'a cohort value of "title" long enough to search for',
		})
	})

	it("stands down when the select grammar cannot write the projection", () => {
		expect(stage(querySearchAndSelectCompose, { fields: fleetingSelect() }).plan()).toEqual({ ok: false })
	})
})
