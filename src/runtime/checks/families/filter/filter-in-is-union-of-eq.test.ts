import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { members, OPS } from "./__fixtures__/backend.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"
import { filterInIsUnionOfEq as check } from "./filter-in-is-union-of-eq.ts"

const COHORT = [
	{ id: "w-1", status: "open" },
	{ id: "w-2", status: "shut" },
	{ id: "w-3", status: "open" },
	{ id: "w-4", status: "held" },
]
const DOC = { xQuery: { filterable: [{ field: "status", ops: ["eq", "in"] }] } }
/** FILTER_IN_FIRST_ONLY: in() matches only the first listed value. */
const FIRST_ONLY = { ops: { in: (value: unknown, arg: string) => value === members(arg)[0] } }

describe("filter.in-is-union-of-eq", () => {
	it("asserts when in(a,b) selects exactly what eq a and eq b select together", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["status.in.(open,shut)", "status.eq.open", "status.eq.shut"])
		expect(findings.findings).toEqual([])
	})

	it("reports an in() that matches only its first member, after a fresh read repeats it", async () => {
		const { ctx, findings, sent } = stage({ behavior: FIRST_ONLY, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(sent).toHaveLength(6)
		expect(only(findings).detail).toBe("status.in.(open,shut) returned 2 record(s); eq on each value together match 3.")
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toEqual({
			kind: "unresolved",
			reason: "one of the listings needed for in() was rejected",
		})
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: expect.stringContaining("larger than the walk"),
		})
		const store = growing(COHORT, 3, { id: "w-5", status: "open" })
		const moving = stage({ behavior: FIRST_ONLY, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
		expect(moving.findings.findings).toEqual([])
	})

	it("stands down without a filter, two distinct values, or a grammar that can write the terms", () => {
		expect(check.plan(stage({ doc: { ...DOC, filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, records: [{ id: "w-1", status: "open" }] }).ctx).ok).toBe(false)
		expect(check.plan(stage({ conventions: reserving("o"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express in and eq",
			ok: false,
		})
	})

	it("passes values through as typed terms", () => {
		const numeric = stage({
			doc: { xQuery: { filterable: [{ field: "amount", ops: ["eq", "in"] }] } },
			records: [
				{ amount: 1, id: "a" },
				{ amount: 2, id: "b" },
			],
		})
		expect(check.plan(numeric.ctx)).toMatchObject({ value: { inTerm: { filter: "amount.in.(1,2)" } } })
		expect(OPS.in?.(1, "(1,2)")).toBe(true)
	})
})
