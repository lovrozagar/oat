import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { STORED_FIELDS_UNKNOWN } from "../../planning/stand-down.ts"
import { endless, filters, only, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"
import { numericComparisonIsNumeric as check } from "./filter-numeric-comparison-is-numeric.ts"

/** Numeric order 2 < 5 < 13; text order "13" < "2" < "5". */
const COHORT = [
	{ amount: 2, id: "n-low" },
	{ amount: 5, id: "n-mid" },
	{ amount: 13, id: "n-high" },
]
/** A row the store holds that oat never seeded. */
const OUTSIDE = { amount: 9, id: "x-gt" }
const DOC = { xQuery: { filterable: ["amount"] } }
/** Compares the query value as text: the defect the check exists for. */
const LEXICAL = { ops: { gt: (value: unknown, arg: string) => typeof value === "number" && String(value) > arg } }

describe("filter.numeric-comparison-is-numeric: run", () => {
	it("asserts when gt compares numerically, ignoring rows oat did not seed", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT, store: [...COHORT, OUTSIDE] })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["amount.gt.5"])
		expect(findings.findings).toEqual([])
	})

	it("reports a comparison made on text, naming the lexical cause", async () => {
		const { ctx, findings } = stage({ behavior: LEXICAL, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const finding = only(findings)
		expect(finding.summary).toBe('"amount" is compared as text rather than as a number')
		expect(finding.detail).toBe(
			"filter=amount.gt.5 returned 0 record(s); 1 known records hold a greater numeric value. Missing: n-high. " +
				"Unexpected: none. Every missing record is one whose value sorts below the threshold as a string, so the " +
				"comparison is lexical: the query value was never coerced from text.",
		)
	})

	it("reports a comparison that disagrees with numeric order for another reason", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { gt: () => true } }, doc: DOC, records: COHORT })
		await runCheck(check, ctx)
		const finding = only(findings)
		expect(finding.summary).toBe('"amount" comparison does not agree with numeric ordering')
		expect(finding.detail).toContain("Missing: none. Unexpected: n-low, n-mid. The comparison does not agree")
	})

	it("does not blame text comparison when a missing record sorts above the threshold as text too", async () => {
		const cohort = [1, 2, 3, 4, 10].map((amount) => ({ amount, id: `n-${amount}` }))
		const { ctx, findings } = stage({ behavior: { ops: { gt: () => false } }, doc: DOC, records: cohort })
		await runCheck(check, ctx)
		expect(only(findings).summary).toBe('"amount" comparison does not agree with numeric ordering')
	})

	it("is unresolved when the comparison is refused or the set is larger than a read", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toEqual({ kind: "unresolved", reason: "page 1 was answered with 400" })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toEqual({
			kind: "unresolved",
			reason: "the filtered set is larger than a read covers",
		})
	})
})

describe("filter.numeric-comparison-is-numeric: plan", () => {
	it("picks only a non-identity field whose numeric and text orders disagree", () => {
		const agreeing = [1, 2, 3].map((amount) => ({ amount, id: `n-${amount}`, score: amount * 7 }))
		expect(
			check.plan(stage({ doc: { xQuery: { filterable: ["amount", "score"] } }, records: agreeing }).ctx),
		).toMatchObject({
			ok: true,
			value: { field: "score", threshold: 14 },
		})
		const numericIds = [2, 5, 13].map((id) => ({ amount: 1, id }))
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["id", "amount"] } }, records: numericIds }).ctx).ok).toBe(
			false,
		)
		const sparse = [{ amount: 2, id: "a" }, { amount: 13, id: "b" }, { id: "c" }]
		expect(check.plan(stage({ doc: DOC, records: sparse }).ctx).ok).toBe(false)
	})

	it("stands down without a filter, three records, a value above the median, or a gt term", () => {
		expect(check.plan(stage({ doc: { ...DOC, filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, records: COHORT.slice(0, 2) }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, fields: { query: null }, records: COHORT }).ctx).ok).toBe(false)
		const topHeavy = [5, 13, 13].map((amount, i) => ({ amount, id: `t-${i}` }))
		expect(check.plan(stage({ doc: DOC, records: topHeavy }).ctx)).toEqual({
			needs: 'a cohort value of "amount" above the median',
			ok: false,
		})
		expect(check.plan(stage({ conventions: reserving("5"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar with a gt operator",
			ok: false,
		})
	})

	it("leaves a record without an identity out of what it expects", () => {
		const records = [...COHORT, { amount: 20 }, { amount: 1, id: "n-min" }]
		expect(check.plan(stage({ doc: DOC, records }).ctx)).toMatchObject({ value: { expected: ["n-high"] } })
	})
})

describe("filter.numeric-comparison-is-numeric: records oat sent, never read back", () => {
	it("stands down, since what the server stored is not known", () => {
		const { ctx } = stage({ doc: DOC, records: COHORT })
		expect(check.plan(ctx).ok).toBe(true)
		expect(check.plan({ ...ctx, recordsUnverified: true })).toEqual({ needs: STORED_FIELDS_UNKNOWN, ok: false })
	})
})
