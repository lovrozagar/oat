import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { backend, NOTES, PARAMS, queryDoc, queryOf, stage } from "../composition/__fixtures__/query-api.ts"
import { ignoring, refusingOrder } from "./__fixtures__/sort-api.ts"
import { sortNullsFirstLast } from "./sort-nulls-first-last.ts"

const placing = (nulls: readonly string[]) => queryDoc({ sort: { nulls } })
const both = placing(["first", "last"])

/* Rewrites the order before the correct backend reads it. */
const rewriting =
	(from: RegExp, to: string): Responder =>
	(method, path, options) => {
		const query = queryOf(options)
		return backend()(method, path, { query: { ...query, order: query.order?.replace(from, to) } })
	}

/* Drops the nulls token: ascending puts nulls last, whatever was asked. */
const ignoringNulls = rewriting(/\.nulls(first|last)$/, "")
/* Puts nulls first, whatever was asked. */
const alwaysFirst = rewriting(/nullslast$/, "nullsfirst")

const empty: Responder = () => ({ body: [], status: 200 })

describe("sort.nulls-first-last judges", () => {
	it("passes a backend that places nulls where each clause asks", async () => {
		const staged = stage(sortNullsFirstLast, { doc: both })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual([
			"score.asc.nullsfirst",
			"score.asc.nullslast",
		])
	})

	it("fails a backend that ignores nullsfirst", async () => {
		const staged = stage(sortNullsFirstLast, { doc: both, respond: ignoringNulls })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: "order=score.asc.nullsfirst started with 1.",
			summary: "nullsfirst did not put nulls first",
		})
	})

	it("reports a backend that ignores nullslast, and still returns asserted", async () => {
		const staged = stage(sortNullsFirstLast, { doc: both, respond: alwaysFirst })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.findings.findings).toMatchObject([
			{ detail: "order=score.asc.nullslast ended with 7.", summary: "nullslast did not put nulls last" },
		])
	})

	it("passes an empty listing: there is no first or last record to misplace", async () => {
		expect(await stage(sortNullsFirstLast, { doc: both, respond: empty }).run()).toEqual({ kind: "asserted" })
	})

	it("sends only the clause each declared placement allows", async () => {
		const first = stage(sortNullsFirstLast, { doc: placing(["first"]) })
		expect(await first.run()).toEqual({ kind: "asserted" })
		expect(first.sent.map((sent) => sent.options.query?.order)).toEqual(["score.asc.nullsfirst"])
		const last = stage(sortNullsFirstLast, { doc: placing(["last"]) })
		expect(await last.run()).toEqual({ kind: "asserted" })
		expect(last.sent.map((sent) => sent.options.query?.order)).toEqual(["score.asc.nullslast"])
	})
})

describe("sort.nulls-first-last gives up", () => {
	it("is unresolved when either clause is refused", async () => {
		const first = stage(sortNullsFirstLast, { doc: both, respond: refusingOrder("score.asc.nullsfirst") })
		expect(await first.run()).toEqual({ kind: "unresolved", reason: "nullsfirst listing was rejected" })
		const last = stage(sortNullsFirstLast, { doc: both, respond: refusingOrder("score.asc.nullslast") })
		expect(await last.run()).toEqual({ kind: "unresolved", reason: "nullslast listing was rejected" })
	})

	it("is unresolved when the nullslast walk cannot reach the end of the set", async () => {
		const doc = queryDoc({ sort: { nulls: ["first", "last"] } }, [...PARAMS, "page"])
		const staged = stage(sortNullsFirstLast, { doc, respond: ignoring("page") })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the collection is larger than the walk covers",
		})
	})
})

describe("sort.nulls-first-last plans", () => {
	it("takes a placement declared on the field itself", () => {
		const doc = queryDoc({ sortable: [{ field: "rank" }, { field: "score", nulls: ["last"] }] })
		expect(stage(sortNullsFirstLast, { doc }).plan()).toMatchObject({
			ok: true,
			value: { field: { field: "score" }, firstClause: null, lastClause: "score.asc.nullslast" },
		})
	})

	it("stands down without an order parameter or a grammar with a nulls token", () => {
		const unordered = queryDoc(
			{ sort: { nulls: ["first"] } },
			PARAMS.filter((name) => name !== "order"),
		)
		expect(stage(sortNullsFirstLast, { doc: unordered }).plan().ok).toBe(false)
		expect(
			stage(sortNullsFirstLast, { doc: queryDoc({ sort: { nulls: ["first"] }, sortGrammar: "colon" }) }).plan().ok,
		).toBe(false)
	})

	it("stands down without a declared placement or a null in the cohort", async () => {
		expect(stage(sortNullsFirstLast).plan().ok).toBe(false)
		const filled = stage(sortNullsFirstLast, { doc: both, rows: NOTES.map((row) => ({ ...row, score: 1 })) })
		expect(await filled.run()).toEqual({
			kind: "stood-down",
			reason: "a declared nulls token, a dotted sort grammar, and a null in the cohort",
		})
	})
})
