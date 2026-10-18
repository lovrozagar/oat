import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { backend } from "./__fixtures__/backend.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, stage } from "./__fixtures__/widgets.ts"
import { filterOrComposesAsUnion as check } from "./filter-or-composes-as-union.ts"

const COHORT = [
	{ id: "w-1", name: "alpha", status: "open" },
	{ id: "w-2", name: "beta", status: "open" },
	{ id: "w-3", name: "alpha", status: "shut" },
	{ id: "w-4", name: "gamma", status: "held" },
]
const DOC = { xQuery: { filterable: ["id", "status", "name"] } }
const OR = "or(status.eq.open,name.eq.alpha)"

describe("filter.or-composes-as-union", () => {
	it("asserts when or() selects the union of its terms", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["status.eq.open", "name.eq.alpha", OR])
		expect(findings.findings).toEqual([])
	})

	it("reports or() evaluated as and(), naming the records it misses", async () => {
		const { ctx, findings } = stage({ behavior: { swap: true }, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe(
			`${OR} returned 1 record(s); status.eq.open alone returned 2, name.eq.alpha alone returned 2, whose union ` +
				"is 3. Missing from the combined result: w-2, w-3. " +
				"A disjunction must select exactly the records either term matches alone.",
		)
	})

	it("reports or() that adds a record neither term matches", async () => {
		const correct = backend(COHORT)
		const { ctx, findings } = stage({
			doc: DOC,
			records: COHORT,
			respond: (method, path, options) =>
				options.query?.filter === OR ? { body: { widgets: COHORT }, status: 200 } : correct(method, path, options),
		})
		await runCheck(check, ctx)
		expect(only(findings).detail).toContain(
			"whose union is 3. Present but matches neither term individually: w-4. A disjunction",
		)
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({
			reason: "one of the three listings needed for the union was rejected",
		})
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: "the collection is larger than the walk covers, so the union cannot be verified",
		})
		const store = growing(COHORT, 3, { id: "w-5", name: "alpha", status: "open" })
		const moving = stage({ behavior: { swap: true }, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
	})

	it("stands down without an or() combinator or two filterable fields", () => {
		expect(check.plan(stage({ doc: { xQuery: { ...DOC.xQuery, grammar: "colon" } }, records: COHORT }).ctx).ok).toBe(
			false,
		)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, fields: { query: null }, records: COHORT }).ctx).ok).toBe(false)
	})
})
