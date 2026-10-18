import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { filters, only, stage, without } from "./__fixtures__/widgets.ts"
import { unknownFilterRejected as check } from "./filter-unknown-field-rejected.ts"

const COHORT = [
	{ id: "w-1", status: "open" },
	{ id: "w-2", status: "shut" },
]

describe("filter.unknown-field-rejected", () => {
	it("asserts when a term on an undeclared field is refused", async () => {
		const { ctx, findings, sent } = stage({ records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["-", "oat_no_such_field_xyz.eq.1"])
		expect(findings.findings).toEqual([])
	})

	it("reports a backend that drops the unknown term and serves the unfiltered set", async () => {
		const { ctx, findings } = stage({ behavior: { policy: { unknown: "drop" } }, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const finding = only(findings)
		expect(finding.summary).toBe("unknown filter field is silently ignored")
		expect(finding.detail).toContain("returned 200 with 2 of 2 records — identical to the unfiltered result")
	})

	it("reports an accepted unknown term even when the rows it served differ", async () => {
		const { ctx, findings } = stage({ behavior: { policy: { unknown: "apply" } }, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const { detail } = only(findings)
		expect(detail).toContain("returned 200 with 0 of 2 records. A filter")
		expect(detail).not.toContain("identical")
	})

	it("reports a server error on the unknown term", async () => {
		const { ctx, findings } = stage({ behavior: { policy: { unknown: 503 } }, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).summary).toBe("unknown filter field produces a server error")
	})

	it("stands down without a filter expression parameter or an eq operator", () => {
		expect(check.plan(stage({ doc: { filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ conventions: without("eq"), records: COHORT }).ctx).ok).toBe(false)
	})
})
