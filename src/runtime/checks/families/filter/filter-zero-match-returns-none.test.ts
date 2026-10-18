import { describe, expect, it } from "vitest"
import { NO_ABSENT_ID } from "../../payloads/identity.ts"
import { runCheck } from "../../core/run.ts"
import { filters, only, reserving, stage } from "./__fixtures__/widgets.ts"
import { zeroMatchFilter as check } from "./filter-zero-match-returns-none.ts"

const COHORT = [
	{ id: "w-1", status: "open" },
	{ id: "w-2", status: "open" },
]
const ID_FILTERABLE = { xQuery: { filterable: ["id", "status"] } }

describe("filter.zero-match-returns-none", () => {
	it("asserts when eq on an identity no record holds returns nothing", async () => {
		const { ctx, findings, sent } = stage({ doc: ID_FILTERABLE, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual([expect.stringMatching(/^id\.eq\.oat-absent-/)])
		expect(findings.findings).toEqual([])
	})

	it("reports a backend that serves records for a predicate nothing satisfies", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { eq: () => true } }, doc: ID_FILTERABLE, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toContain("a filter on a value no record holds returned 2 records")
	})

	it("reads a refused filter as unresolved", async () => {
		const { ctx } = stage({ behavior: { status: () => 422 }, doc: ID_FILTERABLE, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "unresolved", reason: "the zero-match filter was rejected" })
	})

	it("stands down without a filter, a filterable identity, an absent identity, or a writable term", () => {
		expect(check.plan(stage({ doc: { filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		const enumerated = stage({
			doc: { ...ID_FILTERABLE, idSchema: { enum: ["w-1", "w-2"], type: "string" } },
			records: COHORT,
		})
		expect(check.plan(enumerated.ctx)).toEqual({ needs: NO_ABSENT_ID, ok: false })
		expect(check.plan(stage({ conventions: reserving("-"), doc: ID_FILTERABLE, records: COHORT }).ctx).ok).toBe(false)
	})
})
