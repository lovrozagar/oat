import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { filters, only, stage, without } from "./__fixtures__/widgets.ts"
import { filterConditionCapRejected as check } from "./filter-condition-cap-rejected.ts"

const COHORT = [{ id: "w-1", status: "open" }]
const CAPPED = { xQuery: { filterable: ["id", "status"], maxFilterConditions: 2 } }

/** Whether the check plans to run against the staged listing. */
function plan(options: Parameters<typeof stage>[0]): boolean {
	return check.plan(stage(options).ctx).ok
}

describe("filter.condition-cap-rejected", () => {
	it("asserts when one condition past the cap is refused", async () => {
		const { ctx, findings, sent } = stage({ behavior: { maxConditions: 2 }, doc: CAPPED, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["and(id.eq.oat-cap,id.eq.oat-cap,id.eq.oat-cap)"])
		expect(findings.findings).toEqual([])
	})

	it("reports a backend that accepts more conditions than it documents", async () => {
		const { ctx, findings } = stage({ doc: CAPPED, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("maxFilterConditions=2 but 3 eq terms returned 200.")
	})

	it("stands down without a cap, a filter parameter, a grouping grammar, or a filterable identity", () => {
		expect(plan({ doc: { xQuery: { filterable: ["id"] } }, records: COHORT })).toBe(false)
		expect(plan({ doc: { ...CAPPED, filterParam: false }, records: COHORT })).toBe(false)
		expect(plan({ doc: { xQuery: { ...CAPPED.xQuery, grammar: "colon" } }, records: COHORT })).toBe(false)
		expect(plan({ doc: { xQuery: { filterable: ["status"], maxFilterConditions: 2 } }, records: COHORT })).toBe(false)
	})

	it("stands down when the grammar cannot write the grouped terms", () => {
		expect(check.plan(stage({ conventions: without("eq"), doc: CAPPED, records: COHORT }).ctx).ok).toBe(false)
	})
})
