import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { filters, only, reserving, stage } from "./__fixtures__/widgets.ts"
import { filterInOverLimitRejected as check } from "./filter-in-over-limit-rejected.ts"

const COHORT = [{ id: "w-1", status: "open" }]
const CAPPED = { xQuery: { filterable: [{ field: "status", ops: ["eq", "in"] }], maxInValues: 2 } }

describe("filter.in-over-limit-rejected", () => {
	it("asserts when an in() list one past the maximum is refused", async () => {
		const { ctx, findings, sent } = stage({ behavior: { maxIn: 2 }, doc: CAPPED, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["status.in.(oat-over-limit-0,oat-over-limit-1,oat-over-limit-2)"])
		expect(sent[0]?.options.query).toMatchObject({ limit: 5 })
		expect(findings.findings).toEqual([])
	})

	it("reports a backend that accepts a longer in() list than it documents", async () => {
		const { ctx, findings } = stage({ doc: CAPPED, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("maxInValues=2 but status.in with 3 members returned 200.")
	})

	it("stands down without a documented maximum or a field that allows in", () => {
		const uncapped = { xQuery: { filterable: [{ field: "status", ops: ["eq", "in"] }] } }
		expect(check.plan(stage({ doc: uncapped, records: COHORT }).ctx).ok).toBe(false)
		const noIn = { xQuery: { filterable: [{ field: "status", ops: ["eq"] }], maxInValues: 2 } }
		expect(check.plan(stage({ doc: noIn, records: COHORT }).ctx).ok).toBe(false)
	})

	it("stands down when the grammar cannot write the members", () => {
		expect(check.plan(stage({ conventions: reserving("-"), doc: CAPPED, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express in()",
			ok: false,
		})
	})
})
