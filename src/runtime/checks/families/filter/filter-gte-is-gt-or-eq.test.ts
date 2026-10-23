import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { OPS } from "./__fixtures__/backend.ts"
import { filters, only, stage } from "./__fixtures__/widgets.ts"
import { filterGteIsGtOrEq as check } from "./filter-gte-is-gt-or-eq.ts"

const COHORT = [1, 2, 3, 4, 5, 6].map((amount) => ({ amount, id: `w-${amount}` }))
const DOC = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "gte", "lt"], type: "number" }] } }

describe("filter.gte-is-gt-or-eq", () => {
	it("asserts when gte selects gt plus eq", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["amount.gte.3", "amount.gt.3", "amount.eq.3"])
		expect(findings.findings).toEqual([])
	})

	it("reports gte implemented as gt", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { gte: OPS["gt"] } }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings)).toMatchObject({ check: "filter.gte-is-gt-or-eq", summary: "gte is not gt ∪ eq" })
	})

	it("stands down on a field that does not allow gte", async () => {
		const noGte = { xQuery: { filterable: [{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" }] } }
		expect(await runCheck(check, stage({ doc: noGte, records: COHORT }).ctx)).toEqual({
			kind: "stood-down",
			reason: "an ordered field that allows `gte`",
		})
	})
})
