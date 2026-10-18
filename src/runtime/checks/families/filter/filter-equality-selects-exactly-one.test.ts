import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { filters, only, stage, without } from "./__fixtures__/widgets.ts"
import { equalityFilterSelectsOne as check } from "./filter-equality-selects-exactly-one.ts"

const COHORT = [
	{ amount: 1, id: "w-1", status: "open" },
	{ amount: 2, id: "w-2", status: "open" },
]

const ID_FILTERABLE = { xQuery: { filterable: ["id", "status"] } }

describe("filter.equality-selects-exactly-one", () => {
	it("asserts when eq on the identity returns that one record", async () => {
		const { ctx, findings, sent } = stage({ doc: ID_FILTERABLE, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["id.eq.w-1"])
		expect(findings.findings).toEqual([])
	})

	it("reports a backend whose eq matches every record", async () => {
		const { ctx, findings } = stage({
			behavior: { ops: { eq: () => true } },
			doc: ID_FILTERABLE,
			records: COHORT,
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("filter=id.eq.w-1 returned 2 records (w-1, w-2)")
	})

	it("reads a refused equality filter as unresolved, not as zero records", async () => {
		const { ctx, findings } = stage({ behavior: { status: () => 400 }, doc: ID_FILTERABLE, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "unresolved", reason: "the equality filter was rejected" })
		expect(findings.findings).toEqual([])
	})

	it("stands down without a filter, a filterable identity, or a cohort", async () => {
		const noFilter = stage({ doc: { filterParam: false, xQuery: { grammar: "colon" } }, records: COHORT })
		expect(check.plan(noFilter.ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: ID_FILTERABLE, records: [] }).ctx).ok).toBe(false)
	})

	it("stands down on a record without an identity, or a grammar without eq", async () => {
		const anonymous = stage({ doc: ID_FILTERABLE, records: [{ status: "open" }] })
		expect(check.plan(anonymous.ctx)).toEqual({ needs: expect.stringContaining("identity"), ok: false })
		const noEq = stage({ conventions: without("eq"), doc: ID_FILTERABLE, records: COHORT })
		expect(check.plan(noEq.ctx)).toEqual({
			needs: "a filter grammar that can express equality on the identity",
			ok: false,
		})
	})
})
