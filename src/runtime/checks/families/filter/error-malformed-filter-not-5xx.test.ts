import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { filters, only, stage, without } from "./__fixtures__/widgets.ts"
import { malformedFilterNot5xx as check } from "./error-malformed-filter-not-5xx.ts"

const COHORT = [{ id: "w-1", status: "open" }]

describe("error.malformed-filter-not-5xx", () => {
	it("asserts when a syntactically invalid filter is refused with a 4xx", async () => {
		const { ctx, findings, sent } = stage({ records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["(((("])
		expect(sent[0]?.options.query).toMatchObject({ limit: 10 })
		expect(findings.findings).toEqual([])
	})

	it("reports a parser that throws a 5xx on bad input", async () => {
		const { ctx, findings } = stage({ behavior: { policy: { malformed: 500 } }, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const finding = only(findings)
		expect(finding.summary).toBe("malformed filter input produces a server error")
		expect(finding.detail).toContain("a syntactically invalid filter returned 500.")
	})

	it("judges a well-formed filter on an unknown field when the backend accepts malformed syntax", async () => {
		const crashes = stage({ behavior: { policy: { malformed: "drop", unknown: 500 } }, records: COHORT })
		expect(await runCheck(check, crashes.ctx)).toMatchObject({ kind: "finding" })
		expect(filters(crashes.sent)).toEqual(["((((", "oat_no_such_field_xyz.eq.1"])
		expect(only(crashes.findings).detail).toContain("returned 500")
		const refuses = stage({ behavior: { policy: { malformed: "drop", unknown: 400 } }, records: COHORT })
		expect(await runCheck(check, refuses.ctx)).toEqual({ kind: "asserted" })
	})

	it("is unresolved when the backend accepts both, so no refusal was ever answered", async () => {
		const { ctx, findings } = stage({ behavior: { policy: { malformed: "drop", unknown: "drop" } }, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "unresolved" })
		expect(findings.inconclusive[0]?.reason).toContain("accepted")
	})

	it("is unresolved when malformed syntax is accepted and the grammar cannot spell a term to refuse", async () => {
		const { ctx, findings, sent } = stage({
			behavior: { policy: { malformed: "drop" } },
			conventions: without("eq"),
			records: COHORT,
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "unresolved" })
		expect(filters(sent)).toEqual(["(((("])
		expect(findings.inconclusive[0]?.reason).toBe(
			"the malformed filter was accepted (200), so whether a refused filter answers a 4xx is untested",
		)
	})

	it("stands down where no filter can be expressed", async () => {
		const { ctx, sent } = stage({ doc: { filterParam: false }, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "stood-down" })
		expect(sent).toEqual([])
	})
})
