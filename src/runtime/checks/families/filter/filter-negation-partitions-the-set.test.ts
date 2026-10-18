import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { resolvedCaps } from "../../query/capabilities.ts"
import { endless, filters, only, REFUSE_FILTERED, stage, without } from "./__fixtures__/widgets.ts"
import { negationPartitions as check } from "./filter-negation-partitions-the-set.ts"

const COHORT = [
	{ id: "w-1", note: "kept" },
	{ id: "w-2", note: null },
	{ id: "w-3", note: "gone" },
]
/** A row the store holds that oat never seeded. */
const OUTSIDE = { id: "x-1", note: "other" }
const DOC = { xQuery: { filterable: ["id", "note"] } }
/** NEQ_DROPS_NULLS: neq evaluated as SQL `<>`, which is never true for a null. */
const DROPS_NULLS = {
	ops: { neq: (value: unknown, arg: string) => value !== null && value !== undefined && String(value) !== arg },
}

describe("filter.negation-partitions-the-set: run", () => {
	it("asserts when eq and neq split the whole set, nulls included", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		/* A field with nulls is preferred over the identity, which is never null. */
		expect(filters(sent)).toEqual(["-", "note.eq.kept", "note.neq.kept"])
		expect(findings.findings).toEqual([])
	})

	it("reports a neq that drops nulls, naming three-valued logic", async () => {
		const { ctx, findings } = stage({ behavior: DROPS_NULLS, doc: DOC, records: COHORT })
		/* The finding is reported along the way; the outcome stays asserted. */
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		const finding = only(findings)
		expect(finding.summary).toBe("a predicate and its negation do not cover the full set")
		expect(finding.detail).toContain(
			"1 record(s) match neither note.eq nor note.neq: w-2. Every one of them has note = null",
		)
	})

	it("reports missing records that are not all null without blaming nulls", async () => {
		const { ctx, findings } = stage({
			behavior: { ops: { neq: () => false } },
			doc: DOC,
			records: COHORT,
			store: [...COHORT, OUTSIDE],
		})
		await runCheck(check, ctx)
		expect(only(findings).detail).toBe(
			"3 record(s) match neither note.eq nor note.neq: w-2, w-3, x-1. A record must satisfy either a predicate or its negation.",
		)
	})

	it("reports an eq and a neq that both match a record", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { eq: () => true } }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("2 record(s) appear in both note.eq and note.neq results: w-2, w-3")
	})

	it("is unresolved when a listing is refused or incomplete", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({
			reason: "one of the three listings needed for the partition was rejected",
		})
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: expect.stringContaining("larger than the walk"),
		})
	})
})

describe("filter.negation-partitions-the-set: plan", () => {
	it("falls back to the identity without a nullable field", () => {
		const full = stage({
			doc: DOC,
			records: [
				{ id: "w-1", note: "a" },
				{ id: "w-2", note: "b" },
			],
		})
		expect(check.plan(full.ctx)).toMatchObject({ value: { field: "id", value: "w-1" } })
	})

	it("stands down without a filter, two records, a filterable identity, a value, or neq", () => {
		expect(check.plan(stage({ doc: { ...DOC, filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, records: COHORT.slice(0, 1) }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["note"] } }, records: COHORT }).ctx).ok).toBe(false)
		const base = stage({ doc: DOC, records: COHORT })
		const uuid = {
			capabilities: { ...resolvedCaps(base.ctx), filterable: [{ field: "uuid" }], identityFilter: "uuid" },
		}
		expect(check.plan(stage({ doc: DOC, fields: uuid, records: COHORT }).ctx)).toEqual({
			needs: 'a cohort record with a non-null "uuid" to negate',
			ok: false,
		})
		expect(check.plan(stage({ conventions: without("neq"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express negation",
			ok: false,
		})
	})
})
