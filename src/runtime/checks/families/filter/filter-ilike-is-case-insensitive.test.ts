import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { OPS } from "./__fixtures__/backend.ts"
import { endless, filters, only, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"
import { filterIlikeIsCaseInsensitive as check } from "./filter-ilike-is-case-insensitive.ts"

const COHORT = [
	{ id: "w-0", name: 7 },
	{ id: "w-1", name: "42" },
	{ id: "w-2", name: "Alpha" },
	{ name: "Alpha" },
	{ id: "w-3", name: "beta" },
]
const DOC = { xQuery: { filterable: [{ field: "name", ops: ["eq", "like", "ilike"] }] } }

describe("filter.ilike-is-case-insensitive", () => {
	it("asserts when ilike finds the case-flipped value that like does not", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["name.like.alpha", "name.ilike.alpha"])
		expect(findings.findings).toEqual([])
	})

	it("flips a lowercase first letter to uppercase", () => {
		const lower = stage({ doc: DOC, records: [{ id: "w-3", name: "beta" }] })
		expect(check.plan(lower.ctx)).toMatchObject({ value: { flipped: "Beta", sample: "beta" } })
	})

	it("reports ilike implemented as like", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { ilike: OPS["like"] } }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe('ilike on "alpha" did not select the record whose name is "Alpha".')
	})

	it("is unresolved when like itself ignores case", async () => {
		const { ctx, findings } = stage({ behavior: { ops: { like: OPS["ilike"] } }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({
			reason: "like also matched the case-flipped value — the store may already be case-insensitive",
		})
		expect(findings.findings).toEqual([])
	})

	it("is unresolved when a probe is refused or a set is larger than a read", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({ reason: "like/ilike probe was rejected" })
		const ilikeRefused = stage({
			behavior: { status: (query) => (String(query["filter"]).includes("ilike") ? 400 : undefined) },
			doc: DOC,
			records: COHORT,
		})
		expect(await runCheck(check, ilikeRefused.ctx)).toMatchObject({ reason: "like/ilike probe was rejected" })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({ reason: "the sets are larger than a read covers" })
	})

	it("stands down without like and ilike, a letter to flip, or writable terms", () => {
		const noLike = { xQuery: { filterable: [{ field: "name", ops: ["eq", "ilike"] }] } }
		expect(check.plan(stage({ doc: noLike, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, records: [{ id: "w-1", name: "42" }] }).ctx)).toEqual({
			needs: 'a cohort value of "name" holding a letter to case-flip',
			ok: false,
		})
		expect(check.plan(stage({ conventions: reserving("a"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar that can express like and ilike",
			ok: false,
		})
	})
})
