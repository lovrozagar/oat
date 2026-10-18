import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { backend } from "./__fixtures__/backend.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, stage } from "./__fixtures__/widgets.ts"
import { filterAndComposesAsIntersection as check } from "./filter-and-composes-as-intersection.ts"

const COHORT = [
	{ id: "w-1", name: "alpha", status: "open" },
	{ id: "w-2", name: "beta", status: "open" },
	{ id: "w-3", name: "alpha", status: "shut" },
]
const DOC = { xQuery: { filterable: ["id", "status", "name"] } }
const AND = "and(status.eq.open,name.eq.alpha)"

describe("filter.and-composes-as-intersection", () => {
	it("asserts when and() selects the intersection of its terms", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["status.eq.open", "name.eq.alpha", AND])
		expect(findings.findings).toEqual([])
	})

	it("reports and() evaluated as or(), naming the records that should not match both", async () => {
		const { ctx, findings } = stage({ behavior: { swap: true }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe(
			`${AND} returned 3 record(s); status.eq.open alone returned 2, name.eq.alpha alone returned 2, whose ` +
				"intersection is 1. Present but should not match both terms: w-2, w-3. " +
				"A conjunction must select exactly the records both terms match individually.",
		)
	})

	it("reports and() that misses a record both terms match", async () => {
		const correct = backend(COHORT)
		const { ctx, findings } = stage({
			doc: DOC,
			records: COHORT,
			respond: (method, path, options) =>
				options.query?.filter === AND ? { body: { widgets: [] }, status: 200 } : correct(method, path, options),
		})
		await runCheck(check, ctx)
		expect(only(findings).detail).toContain(
			"whose intersection is 1. Missing from the combined result: w-1. A conjunction",
		)
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({
			reason: "one of the three listings needed for the intersection was rejected",
		})
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: "the collection is larger than the walk covers, so the intersection cannot be verified",
		})
		const store = growing(COHORT, 3, { id: "w-4", name: "alpha", status: "open" })
		const moving = stage({ behavior: { swap: true }, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
	})

	it("stands down without a filter or two filterable fields", () => {
		expect(check.plan(stage({ doc: { ...DOC, filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, fields: { query: null }, records: COHORT }).ctx).ok).toBe(false)
	})
})
