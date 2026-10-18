import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { resolvedCaps } from "../../query/capabilities.ts"
import { filters, only, reserving, stage, without } from "./__fixtures__/widgets.ts"
import { filterIllegalOpRejected as check } from "./filter-illegal-op-rejected.ts"

const COHORT = [
	{ amount: 4, id: "w-1", status: "open" },
	{ amount: 9, id: "w-2", status: "shut" },
]
const CLOSED = { xQuery: { filterable: [{ field: "status", ops: ["eq", "in"] }] } }
const POLICED = { closed: { status: ["eq", "in"] } }
/** amount allows only gt; status is open-ended, so only amount yields a closed-list probe. */
const MIXED = { xQuery: { filterable: [{ field: "amount", ops: ["gt"] }, "status"] } }
const REFUSE_GT = {
	status: (query: Record<string, unknown>) => (String(query.filter).startsWith("amount.gt") ? 403 : undefined),
}

describe("filter.illegal-op-rejected: run", () => {
	it("asserts when an operator outside the field's closed list is refused", async () => {
		const { ctx, findings, sent } = stage({ behavior: POLICED, doc: CLOSED, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["status.eq.open", "-", "status.ne.open"])
		expect(findings.findings).toEqual([])
	})

	it("reports an illegal operator accepted and ignored", async () => {
		const { ctx, findings } = stage({
			behavior: { ...POLICED, policy: { illegal: "drop" } },
			doc: CLOSED,
			records: COHORT,
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe(
			"status.ne returned 200 with the unfiltered set, so the operator was ignored. " +
				"A closed operator list is a contract: anything outside it must be rejected.",
		)
	})

	it("reports an illegal operator accepted and applied", async () => {
		const { ctx, findings } = stage({ doc: CLOSED, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe(
			"status.ne returned 200. A closed operator list is a contract: anything outside it must be rejected.",
		)
	})

	it("reports an illegal operator that crashes the handler", async () => {
		const { ctx, findings } = stage({
			behavior: { ...POLICED, policy: { illegal: 500 } },
			doc: CLOSED,
			records: COHORT,
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).summary).toBe("an illegal filter operator produces a server error")
	})

	it("probes an operator the grammar lacks once the closed-list field is turned away", async () => {
		const asserted = stage({ behavior: REFUSE_GT, doc: MIXED, records: COHORT })
		expect(await runCheck(check, asserted.ctx)).toEqual({ kind: "asserted" })
		expect(filters(asserted.sent)).toEqual(["amount.gt.4", "amount.eq.4", "-", "amount.zz.4"])
		const dropped = stage({ behavior: { ...REFUSE_GT, policy: { unknown: "drop" } }, doc: MIXED, records: COHORT })
		await runCheck(check, dropped.ctx)
		expect(only(dropped.findings).detail).toContain(
			"amount.zz returned 200 with the unfiltered set, so the operator was ignored. The declared grammar has no such operator",
		)
	})

	it("is unresolved when no field is accepted even under an operator it allows", async () => {
		const { ctx, findings } = stage({ behavior: { status: () => 403 }, doc: MIXED, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({
			kind: "unresolved",
			reason: "no field with a closed operator list accepted even an operator it allows",
		})
		expect(findings.findings).toEqual([])
	})
})

describe("filter.illegal-op-rejected: plan", () => {
	it("plans with a stand-in value, skips alias spellings, and probes the next writable field", () => {
		const unset = stage({ doc: { xQuery: { filterable: [{ field: "note", ops: ["eq"] }] } }, records: COHORT })
		expect(check.plan(unset.ctx)).toMatchObject({
			value: { probes: [{ term: { filter: "note.ne.oat-probe" } }, { term: { filter: "note.zz.oat-probe" } }] },
		})
		const aliased = stage({
			doc: { xQuery: { aliases: { ne: "neq" }, filterable: [{ field: "status", ops: ["eq", "neq"] }] } },
			records: COHORT,
		})
		expect(check.plan(aliased.ctx)).toMatchObject({ value: { probes: [{ op: "gt" }, { op: "zz" }] } })
		const skipFirst = stage({
			conventions: reserving("4"),
			doc: { xQuery: { filterable: ["amount", "status"] } },
			records: COHORT,
		})
		expect(check.plan(skipFirst.ctx)).toMatchObject({
			value: { probes: [{ kind: "unknown", term: { filter: "status.zz.open" } }] },
		})
	})

	it("skips a field without a writable allowed operator, or whose terms cannot be written", () => {
		const caps = resolvedCaps(stage({ doc: CLOSED, records: COHORT }).ctx)
		const containsOnly = { ...caps, filterable: [{ field: "status", ops: ["contains" as const] }] }
		const noLegal = stage({
			conventions: without("contains"),
			doc: CLOSED,
			fields: { capabilities: containsOnly },
			records: COHORT,
		})
		expect(check.plan(noLegal.ctx)).toMatchObject({ value: { probes: [{ kind: "unknown" }] } })
		expect(check.plan(stage({ conventions: reserving("o"), doc: CLOSED, records: COHORT }).ctx).ok).toBe(false)
	})

	it("stands down without a closed operator list or a declared grammar", () => {
		const undeclared = { xQuery: { filterable: ["status"], grammar: undefined } }
		expect(check.plan(stage({ conventions: { grammar: "postgrest" }, doc: undeclared, records: COHORT }).ctx).ok).toBe(
			false,
		)
		const closedUndeclared = { xQuery: { filterable: [{ field: "status", ops: ["eq"] }], grammar: undefined } }
		expect(
			check.plan(stage({ conventions: { grammar: "postgrest" }, doc: closedUndeclared, records: COHORT }).ctx),
		).toMatchObject({
			value: { probes: [{ kind: "closed" }] },
		})
	})
})
