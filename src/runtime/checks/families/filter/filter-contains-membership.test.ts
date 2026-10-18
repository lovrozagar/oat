import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { resolvedCaps } from "../../query/capabilities.ts"
import { endless, filters, only, REFUSE_FILTERED, reserving, stage, without } from "./__fixtures__/widgets.ts"
import { filterContainsMembership as check } from "./filter-contains-membership.ts"

const COHORT = [
	{ id: "w-1", tags: ["red", "redwood"] },
	{ id: "w-2", tags: ["blue"] },
	{ id: "w-3", tags: ["red"] },
	{ id: "w-4", tags: ["redwood"] },
	{ id: "w-5" },
	{ tags: ["red"] },
]
const DOC = { xQuery: { filterable: [{ field: "tags", ops: ["contains"] }] } }

/** CONTAINS_MATCHES_SUBSTRING: any element containing the value matches. */
const SUBSTRING = {
	ops: {
		contains: (value: unknown, arg: string) => Array.isArray(value) && value.some((item) => String(item).includes(arg)),
	},
}

describe("filter.contains-membership", () => {
	it("asserts when contains selects the records holding the element itself", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		/* "red" occurs inside "redwood", so it is the element that tells membership from substring. */
		expect(filters(sent)).toEqual(["tags.contains.red"])
		expect(findings.findings).toEqual([])
	})

	it("reports a contains that matches elements merely containing the value", async () => {
		const { ctx, findings } = stage({ behavior: SUBSTRING, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe("tags.contains.red returned 3; 2 records hold that element.")
	})

	it("is unresolved when the probe is refused or the set is larger than a walk", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toEqual({ kind: "unresolved", reason: "contains probe was rejected" })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toEqual({
			kind: "unresolved",
			reason: "the collection is larger than the walk covers",
		})
	})

	it("probes the first element when none occurs inside another", () => {
		const plain = stage({ doc: DOC, records: [{ id: "w-1", tags: ["blue", "green"] }] })
		expect(check.plan(plain.ctx)).toMatchObject({ value: { element: "blue" } })
	})

	it("finds the array field by its schema, or by the operators it allows", () => {
		const base = stage({ doc: DOC, records: COHORT })
		const caps = resolvedCaps(base.ctx)
		const bySchema = stage({
			doc: DOC,
			fields: { capabilities: { ...caps, filterable: [{ field: "tags", ops: ["eq"] }] } },
			records: COHORT,
		})
		expect(check.plan(bySchema.ctx).ok).toBe(true)
		const byOps = stage({
			doc: DOC,
			fields: { capabilities: { ...caps, filterable: [{ field: "labels", ops: ["contains"], type: "string" }] } },
			records: [{ id: "w-1", labels: ["x"] }],
		})
		expect(check.plan(byOps.ctx)).toMatchObject({ value: { element: "x" } })
	})

	it("stands down without an array field holding an element, a contains operator, or a writable term", () => {
		expect(check.plan(stage({ doc: DOC, records: [{ id: "w-1", tags: [] }] }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ conventions: without("contains"), doc: DOC, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ conventions: reserving("r"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar with a contains operator",
			ok: false,
		})
	})
})
