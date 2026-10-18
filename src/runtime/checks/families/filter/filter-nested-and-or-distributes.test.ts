import { describe, expect, it } from "vitest"
import { NO_IDENTITY } from "../../planning/subjects.ts"
import { runCheck } from "../../core/run.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"
import { filterNestedAndOrDistributes as check } from "./filter-nested-and-or-distributes.ts"

const COHORT = [
	{ id: "w-1", name: "alpha", status: "open" },
	{ id: "w-2", name: "beta", status: "open" },
	{ id: "w-3", name: "alpha", status: "shut" },
]
const DOC = { xQuery: { filterable: ["id", "status", "name"] } }
/** FILTER_NESTED_COMBINATOR_LEAKS: the nested or() replaces the enclosing and(). */
const LEAKS = { leak: true }

describe("filter.nested-and-or-distributes", () => {
	it("asserts when and(A,or(B,C)) is (A∩B) ∪ (A∩C)", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual([
			"status.eq.open",
			"name.eq.alpha",
			"id.eq.w-1",
			"and(status.eq.open,or(name.eq.alpha,id.eq.w-1))",
		])
		expect(findings.findings).toEqual([])
	})

	it("reports a nested or() that leaks into the enclosing and()", async () => {
		const { ctx, findings } = stage({ behavior: LEAKS, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const finding = only(findings)
		expect(finding.summary).toBe("and(A,or(B,C)) is not (A∩B) ∪ (A∩C)")
		expect(finding.detail).toBe("nested combinator returned 3; the distributed form is 1.")
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({ reason: "a nested and/or listing was rejected" })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: "the collection is larger than the walk covers",
		})
		const store = growing(COHORT, 4, { id: "w-4", name: "alpha", status: "open" })
		const moving = stage({ behavior: LEAKS, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
	})

	it("stands down without a mixed grammar, two other fields, or a filterable identity", () => {
		expect(check.plan(stage({ doc: { xQuery: { ...DOC.xQuery, grammar: "colon" } }, records: COHORT }).ctx).ok).toBe(
			false,
		)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["id", "status"] } }, records: COHORT }).ctx)).toEqual({
			needs: "a cohort record with values on two distinct filterable fields",
			ok: false,
		})
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status", "name"] } }, records: COHORT }).ctx)).toEqual({
			needs: "a filterable identity as a third term to nest and/or",
			ok: false,
		})
	})

	it("stands down on a record without an identity, or terms the grammar cannot write", () => {
		const anonymous = [{ name: "alpha", status: "open" }, ...COHORT]
		expect(check.plan(stage({ doc: DOC, records: anonymous }).ctx)).toEqual({ needs: NO_IDENTITY, ok: false })
		expect(check.plan(stage({ conventions: reserving("-"), doc: DOC, records: COHORT }).ctx)).toEqual({ ok: false })
	})
})
