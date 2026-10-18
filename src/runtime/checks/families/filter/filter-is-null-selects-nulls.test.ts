import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { OPS } from "./__fixtures__/backend.ts"
import { endless, filters, grammar, growing, only, REFUSE_FILTERED, stage } from "./__fixtures__/widgets.ts"
import { filterIsNullSelectsNulls as check } from "./filter-is-null-selects-nulls.ts"

const COHORT = [{ id: "w-1", note: "kept" }, { id: "w-2", note: null }, { id: "w-3", note: "kept" }, { note: null }]
const DOC = { xQuery: { filterable: [{ field: "note", ops: ["eq", "is"] }] } }
/** FILTER_IS_NULL_MATCHES_ALL: is.null matches every row. */
const MATCHES_ALL = { ops: { is: (value: unknown, arg: string) => arg === "null" || (OPS.is?.(value, arg) ?? false) } }

describe("filter.is-null-selects-nulls: run", () => {
	it("asserts when is.null selects exactly the null rows and is.notnull none of them", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["-", "note.is.null", "note.is.notnull"])
		expect(findings.findings).toEqual([])
	})

	it("reports an is.null that matches every row, and the rows on both sides", async () => {
		const { ctx, findings } = stage({ behavior: MATCHES_ALL, doc: DOC, records: COHORT })
		/* The finding is reported along the way; the outcome stays asserted. */
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(only(findings).detail).toBe("is.null returned 3 record(s); 1 cohort rows are null. 2 appear on both sides.")
	})

	it("reports an is.null that misses the null rows", async () => {
		const { ctx, findings } = stage({
			behavior: { ops: { is: (value, arg) => arg !== "null" && (OPS.is?.(value, arg) ?? false) } },
			doc: DOC,
			records: COHORT,
		})
		await runCheck(check, ctx)
		expect(only(findings).detail).toBe("is.null returned 0 record(s); 1 cohort rows are null. ")
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({ reason: expect.stringContaining("was rejected") })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: expect.stringContaining("larger than the walk"),
		})
		const store = growing(COHORT, 3, { id: "w-5", note: null })
		const moving = stage({ behavior: MATCHES_ALL, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
		expect(moving.findings.findings).toEqual([])
	})
})

describe("filter.is-null-selects-nulls: plan", () => {
	it("stands down on a field without mixed nulls, the soft-delete field, or no is operator", () => {
		const allSet = stage({
			doc: DOC,
			records: [
				{ id: "w-1", note: "a" },
				{ id: "w-2", note: "b" },
			],
		})
		expect(check.plan(allSet.ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, fields: { softDelete: "note" }, records: COHORT }).ctx).ok).toBe(false)
		expect(
			check.plan(stage({ doc: { xQuery: { filterable: [{ field: "note", ops: ["eq"] }] } }, records: COHORT }).ctx).ok,
		).toBe(false)
	})

	it("stands down when the grammar's null terms cannot be written", () => {
		const broken = grammar((spec) => ({ ...spec, null: { is: "{conj}", not: "{conj}" } }))
		expect(check.plan(stage({ conventions: broken, doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express is.null",
			ok: false,
		})
	})
})
