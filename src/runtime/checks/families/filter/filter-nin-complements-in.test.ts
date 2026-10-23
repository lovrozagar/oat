import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { STORED_FIELDS_UNKNOWN } from "../../planning/stand-down.ts"
import { members } from "./__fixtures__/backend.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"
import { filterNinComplementsIn as check } from "./filter-nin-complements-in.ts"

const COHORT = [
	{ id: "w-1", status: "open" },
	{ id: "w-2", status: "shut" },
	{ id: "w-3", status: "held" },
	{ id: "w-4", status: null },
]
/** A row the store holds that oat never seeded. */
const OUTSIDE = { id: "x-1", status: "held" }
const DOC = { xQuery: { filterable: [{ field: "status", ops: ["eq", "in", "nin"] }] } }
/** FILTER_NIN_FIRST_ONLY: nin() excludes only the first listed value. */
const FIRST_ONLY = {
	ops: { nin: (value: unknown, arg: string) => value !== null && value !== undefined && value !== members(arg)[0] },
}

describe("filter.nin-complements-in", () => {
	it("asserts when in() and nin() split the non-null set without overlap", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT, store: [...COHORT, OUTSIDE] })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["-", "status.in.(open,shut)", "status.nin.(open,shut)"])
		expect(findings.findings).toEqual([])
	})

	it("reports a nin() that excludes only its first member, so both sides hold a record", async () => {
		const { ctx, findings } = stage({ behavior: FIRST_ONLY, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("1 record(s) appear in both status.in and .nin.")
	})

	it("reports non-null records that neither side matches, leaving unseeded rows out", async () => {
		const { ctx, findings } = stage({
			behavior: { ops: { nin: () => false } },
			doc: DOC,
			records: COHORT,
			store: [...COHORT, OUTSIDE],
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const finding = only(findings)
		expect(finding.summary).toBe("in() and nin() do not cover the non-null set")
		expect(finding.detail).toBe("1 non-null record(s) match neither side.")
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({ reason: expect.stringContaining("nin() was rejected") })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: expect.stringContaining("larger than the walk"),
		})
		const store = growing(COHORT, 3, { id: "w-5", status: "open" })
		const moving = stage({ behavior: FIRST_ONLY, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
	})

	it("lists one member where the cohort holds only one value", () => {
		const single = stage({ doc: DOC, records: [{ id: "w-1", status: "open" }] })
		expect(check.plan(single.ctx)).toMatchObject({ value: { members: ["open"] } })
	})

	it("stands down without a filter, a field allowing in and nin, or a grammar for both", () => {
		expect(check.plan(stage({ doc: { ...DOC, filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		const inOnly = { xQuery: { filterable: [{ field: "status", ops: ["eq", "in"] }] } }
		expect(check.plan(stage({ doc: inOnly, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ conventions: reserving("o"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express in and nin",
			ok: false,
		})
	})
})

describe("filter.nin-complements-in: records oat sent, never read back", () => {
	it("stands down, since what the server stored is not known", () => {
		const { ctx } = stage({ doc: DOC, records: COHORT })
		expect(check.plan(ctx).ok).toBe(true)
		expect(check.plan({ ...ctx, recordsUnverified: true })).toEqual({ needs: STORED_FIELDS_UNKNOWN, ok: false })
	})
})
