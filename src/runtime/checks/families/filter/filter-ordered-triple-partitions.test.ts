import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { STORED_FIELDS_UNKNOWN } from "../../planning/stand-down.ts"
import { OPS } from "./__fixtures__/backend.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"
import { filterOrderedTriplePartitions as check } from "./filter-ordered-triple-partitions.ts"

const COHORT = [
	{ amount: 1, id: "w-1" },
	{ amount: 2, id: "w-2" },
	{ amount: 3, id: "w-3" },
	{ amount: 4, id: "w-4" },
	{ amount: "n/a", id: "w-5" },
]
/** A row the store holds that oat never seeded. */
const OUTSIDE = { amount: 9, id: "x-1" }
const DOC = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" }] } }

describe("filter.ordered-triple-partitions", () => {
	it("asserts when lt, eq and gt split the numeric set without overlap", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT, store: [...COHORT, OUTSIDE] })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["-", "amount.lt.3", "amount.eq.3", "amount.gt.3"])
		expect(findings.findings).toEqual([])
	})

	it("reports lt implemented as lte, which puts the threshold row on two sides", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { lt: OPS["lte"] } }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const finding = only(findings)
		expect(finding.summary).toBe("lt / eq / gt are not pairwise disjoint")
		expect(finding.detail).toBe("1 record(s) appear in more than one of amount lt/eq/gt.")
	})

	it("finds an overlap between the last two sides", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { gt: OPS["gte"] } }, doc: DOC, records: COHORT })
		await runCheck(check, ctx)
		expect(only(findings).summary).toBe("lt / eq / gt are not pairwise disjoint")
	})

	it("reports numeric records that none of the three match", async () => {
		const { ctx, findings } = stage({
			behavior: { ops: { gt: () => false } },
			doc: DOC,
			records: COHORT,
			store: [...COHORT, OUTSIDE],
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("1 numeric record(s) match none of the three predicates.")
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({ reason: "one of the triple listings was rejected" })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: expect.stringContaining("larger than the walk"),
		})
		const store = growing(COHORT, 4, { amount: 1, id: "w-6" })
		const moving = stage({ behavior: { ops: { lt: OPS["lte"] } }, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
	})

	it("stands down without an ordered field, a threshold, or a grammar for the three terms", () => {
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		const tied = [5, 5, 5].map((amount, i) => ({ amount, id: `t-${i}` }))
		expect(check.plan(stage({ doc: DOC, records: tied }).ctx).ok).toBe(false)
		expect(check.plan(stage({ conventions: reserving("3"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express lt, eq and gt",
			ok: false,
		})
	})
})

describe("filter.ordered-triple-partitions: records oat sent, never read back", () => {
	it("stands down, since what the server stored is not known", () => {
		const { ctx } = stage({ doc: DOC, records: COHORT })
		expect(check.plan(ctx).ok).toBe(true)
		expect(check.plan({ ...ctx, recordsUnverified: true })).toEqual({ needs: STORED_FIELDS_UNKNOWN, ok: false })
	})
})
