import { describe, expect, it } from "vitest"
import { OPS } from "./__fixtures__/backend.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"
import { assertRangeUnion, rangePlan, type RangeProbe } from "./range.ts"

const COHORT = [1, 2, 3, 4, 5, 6].map((amount) => ({ amount, id: `w-${amount}` }))
const DOC = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "gte", "lt", "lte"], type: "number" }] } }
const CHECK = "filter.gte-is-gt-or-eq"

function probeFor(options: Parameters<typeof stage>[0]): { probe: RangeProbe; staged: ReturnType<typeof stage> } {
	const staged = stage(options)
	const plan = rangePlan(staged.ctx, "gte", "gt")
	if (!plan.ok) throw new Error("the range plan stood down")
	return { probe: plan.value, staged }
}

describe("rangePlan", () => {
	it("plans the closed, open and equality terms at the lower third of the distinct values", () => {
		const { probe } = probeFor({ doc: DOC, records: COHORT })
		expect(probe).toEqual({
			closed: "gte",
			closedTerm: { filter: "amount.gte.3" },
			eqTerm: { filter: "amount.eq.3" },
			field: "amount",
			open: "gt",
			openTerm: { filter: "amount.gt.3" },
			threshold: 3,
		})
	})

	it("stands down without an ordered field, the closed operator, a threshold, or writable terms", () => {
		expect(rangePlan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx, "gte", "gt")).toEqual(
			{
				ok: false,
			},
		)
		const noGte = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" }] } }
		expect(rangePlan(stage({ doc: noGte, records: COHORT }).ctx, "gte", "gt")).toEqual({
			needs: "an ordered field that allows `gte`",
			ok: false,
		})
		const tied = [5, 5, 5].map((amount, i) => ({ amount, id: `t-${i}` }))
		expect(rangePlan(stage({ doc: DOC, records: tied }).ctx, "gte", "gt")).toEqual({ ok: false })
		expect(rangePlan(stage({ conventions: reserving("3"), doc: DOC, records: COHORT }).ctx, "lte", "lt")).toEqual({
			needs: "a filter grammar that can express lte, lt and eq",
			ok: false,
		})
	})
})

describe("assertRangeUnion", () => {
	it("asserts when the closed range is the open range plus equality", async () => {
		const { probe, staged } = probeFor({ doc: DOC, records: COHORT })
		expect(await assertRangeUnion(staged.ctx, CHECK, probe)).toEqual({ kind: "asserted" })
		expect(filters(staged.sent)).toEqual(["amount.gte.3", "amount.gt.3", "amount.eq.3"])
	})

	it("reports a closed range that leaves out the threshold", async () => {
		const { probe, staged } = probeFor({ behavior: { ops: { gte: OPS.gt } }, doc: DOC, records: COHORT })
		expect(await assertRangeUnion(staged.ctx, CHECK, probe)).toMatchObject({ kind: "finding" })
		const finding = only(staged.findings)
		expect(finding.summary).toBe("gte is not gt ∪ eq")
		expect(finding.detail).toBe("amount.gte.3 returned 3; gt ∪ eq is 4.")
		expect(finding.evidence).toHaveLength(3)
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = probeFor({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await assertRangeUnion(refused.staged.ctx, CHECK, refused.probe)).toEqual({
			kind: "unresolved",
			reason: "one of the range listings was rejected",
		})
		const partial = probeFor({ ...endless(DOC), records: COHORT })
		expect(await assertRangeUnion(partial.staged.ctx, CHECK, partial.probe)).toMatchObject({
			reason: "the collection is larger than the walk covers",
		})
		const store = growing(COHORT, 3, { amount: 3, id: "w-7" })
		const moving = probeFor({ behavior: { ops: { gte: OPS.gt } }, doc: DOC, records: COHORT, store })
		expect(await assertRangeUnion(moving.staged.ctx, CHECK, moving.probe)).toMatchObject({
			reason: expect.stringContaining("gained or lost rows"),
		})
	})
})
