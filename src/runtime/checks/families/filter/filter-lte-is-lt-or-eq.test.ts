import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { OPS } from "./__fixtures__/backend.ts"
import { filters, only, stage } from "./__fixtures__/widgets.ts"
import { filterLteIsLtOrEq as check } from "./filter-lte-is-lt-or-eq.ts"

const COHORT = [1, 2, 3, 4, 5, 6].map((amount) => ({ amount, id: `w-${amount}` }))
const DOC = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "lt", "lte"], type: "number" }] } }

describe("filter.lte-is-lt-or-eq", () => {
	it("asserts when lte selects lt plus eq", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["amount.lte.3", "amount.lt.3", "amount.eq.3"])
		expect(findings.findings).toEqual([])
	})

	it("reports lte implemented as lt", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { lte: OPS.lt } }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings)).toMatchObject({
			check: "filter.lte-is-lt-or-eq",
			detail: "amount.lte.3 returned 2; lt ∪ eq is 3.",
		})
	})

	it("stands down on a field that does not allow lte", async () => {
		const noLte = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" }] } }
		expect(await runCheck(check, stage({ doc: noLte, records: COHORT }).ctx)).toEqual({
			kind: "stood-down",
			reason: "an ordered field that allows `lte`",
		})
	})
})
