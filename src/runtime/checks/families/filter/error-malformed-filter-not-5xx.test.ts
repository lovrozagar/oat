import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { filters, only, stage } from "./__fixtures__/widgets.ts"
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

	it("stands down where no filter can be expressed", async () => {
		const { ctx, sent } = stage({ doc: { filterParam: false }, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "stood-down" })
		expect(sent).toEqual([])
	})
})
