import { describe, expect, it } from "vitest"
import type { Record_ } from "../../../world/records.ts"
import { NOTES, PARAMS, queryDoc, stage } from "./__fixtures__/query-api.ts"
import { overlapPlan, projectionBeside, projectionPlan, selectionPlan, sortFieldBeside, subsetPlan } from "./plans.ts"
import { queryAxesCompose } from "./query-axes-compose.ts"

/* The context of a check staged against `rows` under the tag `xQuery`. */
const contextOf = (
	xQuery: Record<string, unknown> = {},
	rows: readonly Record_[] = NOTES,
	params: readonly string[] = PARAMS,
) => stage(queryAxesCompose, { doc: queryDoc(xQuery, params), rows }).ctx

/* A grammar oat cannot read: a bare string `filter` parameter, nothing declared. */
const UNREADABLE = { grammar: undefined }

/* Groups of one, of all, of no searchable overlap, and finally one that overlaps: status "s2". */
const OVERLAP_ROWS: readonly Record_[] = [
	{ id: "a8", rank: 1, status: "solo", title: "q" },
	{ id: "a1", rank: 1, status: "s1", title: "x" },
	{ id: "a2", rank: 1, status: "s1", title: null },
	{ id: "a3", rank: 1, status: "s2", title: "Ab cd" },
	{ id: "a4", rank: 1, status: "s2", title: "Ab q" },
	{ rank: 1, status: "s3", title: "Ab" },
	{ id: "a6", rank: 1, status: null, title: "zz" },
	{ id: "a7", rank: 1, status: "s3", title: "cd" },
]

describe("subsetPlan", () => {
	it("picks a value several records share but not all, as an equality term", () => {
		expect(subsetPlan(contextOf())).toEqual({
			ok: true,
			value: { field: "status", target: NOTES[0], term: { filter: "status.eq.open" } },
		})
	})

	it("passes over the identity, a value every record holds, and absent values", () => {
		const rows = [
			{ id: "r1", score: null, status: "same" },
			{ id: "r2", status: "same" },
			{ id: "r3", score: 5, status: "same" },
			{ id: "r4", score: 5, status: "same" },
			{ id: "r5", score: 7, status: "same" },
		]
		const plan = subsetPlan(contextOf({ filterable: ["id", "status", "score"] }, rows))
		expect(plan).toEqual({ ok: true, value: { field: "score", target: rows[2], term: { filter: "score.eq.5" } } })
	})

	it("reads the cohort it is given: a plan made again on other records answers for them", () => {
		const ctx = contextOf()
		expect(subsetPlan(ctx).ok).toBe(true)
		expect(subsetPlan({ ...ctx, records: [] }).ok).toBe(false)
	})

	it("stands down without a proper subset, or a grammar that writes equality", () => {
		expect(subsetPlan(contextOf({}, NOTES.slice(0, 1)))).toEqual({
			needs: "a filterable value shared by several cohort records but not all of them",
			ok: false,
		})
		expect(subsetPlan(contextOf(UNREADABLE))).toEqual({
			needs: 'a filter grammar that can express equality on "status"',
			ok: false,
		})
	})
})

describe("overlapPlan", () => {
	it("pairs a filter value with a search token each side of which matches something the other does not", () => {
		expect(overlapPlan(contextOf())).toEqual({
			ok: true,
			value: { field: "status", target: NOTES[0], term: { filter: "status.eq.open" }, token: "Alp" },
		})
	})

	it("passes over groups of one, groups of all, nulls, and groups no token overlaps", () => {
		const ctx = contextOf({ filterable: ["id", "rank", "status"] }, OVERLAP_ROWS)
		expect(overlapPlan(ctx)).toEqual({
			ok: true,
			value: { field: "status", target: OVERLAP_ROWS[3], term: { filter: "status.eq.s2" }, token: "cd" },
		})
	})

	it("stands down without a query capability at all", () => {
		const ctx = contextOf()
		ctx.query = null
		expect(subsetPlan(ctx).ok).toBe(false)
		expect(overlapPlan(ctx).ok).toBe(false)
	})

	it("stands down without searchable fields, or a grammar that writes equality", () => {
		expect(overlapPlan(contextOf({ searchable: [] }))).toEqual({
			needs: "a filterable value and a search token that overlap without nesting",
			ok: false,
		})
		expect(overlapPlan(contextOf(UNREADABLE))).toEqual({
			needs: 'a filter grammar that can express equality on "status"',
			ok: false,
		})
	})
})

describe("projectionBeside and projectionPlan", () => {
	it("selects the identity and the first other selectable field", () => {
		const projected = { extra: "title", projection: { select: "id,title" } }
		expect(projectionBeside(contextOf())).toEqual(projected)
		expect(projectionPlan(contextOf())).toEqual({ ok: true, value: projected })
	})

	it("falls back to the identity alone when nothing else is selectable", () => {
		expect(projectionBeside(contextOf({ selectable: ["id"] }))).toEqual({
			extra: "id",
			projection: { select: "id,id" },
		})
		const ctx = contextOf()
		ctx.query = null
		expect(projectionBeside(ctx)).toEqual({ extra: "id", projection: { select: "id,id" } })
	})

	it("stands down where no select parameter can write a fieldset", () => {
		const ctx = contextOf({}, NOTES, ["filter", "order", "q", "limit"])
		expect(projectionBeside(ctx)).toBeNull()
		expect(projectionPlan(ctx)).toEqual({ needs: "a select grammar that can express a sparse fieldset", ok: false })
	})
})

describe("selectionPlan", () => {
	it("writes the requested fieldset, or stands down unexplained without a select parameter", () => {
		expect(selectionPlan(contextOf(), ["id", "rank"])).toEqual({ ok: true, value: { select: "id,rank" } })
		expect(selectionPlan(contextOf({}, NOTES, ["filter", "limit"]), ["id"])).toEqual({ ok: false })
	})
})

describe("sortFieldBeside", () => {
	it("picks a sortable field other than the filtered one and the identity, else the identity", () => {
		expect(sortFieldBeside(contextOf(), "status")).toBe("title")
		expect(sortFieldBeside(contextOf({ sortable: ["status", "id"] }), "status")).toBe("id")
		const ctx = contextOf()
		ctx.query = null
		expect(sortFieldBeside(ctx, "status")).toBe("id")
	})
})
