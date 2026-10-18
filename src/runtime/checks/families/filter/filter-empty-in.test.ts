import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { filters, grammar, only, stage } from "./__fixtures__/widgets.ts"
import { filterEmptyIn as check } from "./filter-empty-in.ts"

const COHORT = [
	{ id: "w-1", status: "open" },
	{ id: "w-2", status: "shut" },
]
const FIELDS = [{ field: "status", ops: ["eq", "in"] }]
const REJECT = { xQuery: { emptyIn: "reject", filterable: FIELDS } }
const MATCH_NONE = { xQuery: { emptyIn: "match-none", filterable: FIELDS } }

describe("filter.empty-in", () => {
	it("asserts a refused empty in() under emptyIn=reject", async () => {
		const { ctx, findings, sent } = stage({ behavior: { policy: { emptyIn: 400 } }, doc: REJECT, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["-", "status.in.()"])
		expect(findings.findings).toEqual([])
	})

	it("reports an accepted empty in() under emptyIn=reject", async () => {
		const { ctx, findings } = stage({ doc: REJECT, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("emptyIn=reject but status.in.() returned 200.")
	})

	it("asserts an empty in() that matches none under emptyIn=match-none", async () => {
		const { ctx, findings } = stage({ doc: MATCH_NONE, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("reports an empty in() that is dropped under emptyIn=match-none", async () => {
		const { ctx, findings } = stage({ behavior: { policy: { emptyIn: "drop" } }, doc: MATCH_NONE, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe(
			"emptyIn=match-none but status.in.() returned 2 record(s) — the unfiltered set, so the filter was ignored.",
		)
	})

	it("reports an empty in() that matches some rows under emptyIn=match-none", async () => {
		const { ctx, findings } = stage({
			behavior: { ops: { in: (value) => value === "open" } },
			doc: MATCH_NONE,
			records: COHORT,
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("emptyIn=match-none but status.in.() returned 1 record(s).")
	})

	it("is unresolved when an empty in() is refused under emptyIn=match-none", async () => {
		const { ctx } = stage({ behavior: { policy: { emptyIn: 400 } }, doc: MATCH_NONE, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({
			kind: "unresolved",
			reason: "empty in() was rejected under match-none",
		})
	})

	it("stands down without a policy, a field that allows in, or a grammar that can write in()", () => {
		expect(check.plan(stage({ doc: { xQuery: { filterable: FIELDS } }, records: COHORT }).ctx).ok).toBe(false)
		const noIn = { xQuery: { emptyIn: "reject", filterable: ["status"] } }
		expect(check.plan(stage({ doc: noIn, records: COHORT }).ctx).ok).toBe(false)
		const bare = grammar((spec) => ({ ...spec, list: { close: "", join: ",", open: "" } }))
		expect(check.plan(stage({ conventions: bare, doc: REJECT, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express an empty in()",
			ok: false,
		})
	})
})
