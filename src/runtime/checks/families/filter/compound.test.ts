import { describe, expect, it } from "vitest"
import { andTerm, orTerm } from "../../../../spec/conventions.ts"
import { compoundPlan, readComposed, twoFilterableFields } from "./compound.ts"
import { endless, filters, growing, REFUSE_FILTERED, reserving, stage } from "./__fixtures__/widgets.ts"

const COHORT = [
	{ id: "w-1", name: "alpha", status: "open" },
	{ id: "w-2", name: "beta", status: "open" },
	{ id: "w-3", name: "alpha", status: "shut" },
]
const DOC = { xQuery: { filterable: ["id", "status", "name"] } }
const intersect = (a: Set<string>, b: Set<string>) => new Set([...a].filter((id) => b.has(id)))

function planned(options: Parameters<typeof stage>[0]) {
	const staged = stage(options)
	const plan = compoundPlan(staged.ctx, andTerm)
	if (!plan.ok) throw new Error("the compound plan stood down")
	return { staged, terms: plan.value }
}

describe("twoFilterableFields", () => {
	it("finds the first record with values on two non-identity fields, once per cohort", () => {
		const records = [{ id: "w-0", name: null, status: "open" }, ...COHORT]
		const { ctx } = stage({ doc: DOC, records })
		const first = twoFilterableFields(ctx)
		expect(first).toEqual({ fieldA: "status", fieldB: "name", target: COHORT[0] })
		expect(twoFilterableFields(ctx)).toBe(first)
	})

	it("is null when no record holds two such values", () => {
		expect(twoFilterableFields(stage({ doc: DOC, records: [{ id: "w-1", status: "open" }] }).ctx)).toBeNull()
	})
})

describe("compoundPlan", () => {
	it("plans both equalities and their combination", () => {
		expect(compoundPlan(stage({ doc: DOC, records: COHORT }).ctx, orTerm)).toEqual({
			ok: true,
			value: {
				combined: { filter: "or(status.eq.open,name.eq.alpha)" },
				fieldA: "status",
				fieldB: "name",
				termA: { filter: "status.eq.open" },
				termB: { filter: "name.eq.alpha" },
				valueA: "open",
				valueB: "alpha",
			},
		})
	})

	it("stands down without two fields on one record, or a grammar for the terms", () => {
		expect(compoundPlan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx, andTerm)).toEqual({
			needs: "a cohort record with values on two distinct filterable fields",
			ok: false,
		})
		expect(compoundPlan(stage({ conventions: reserving("p"), doc: DOC, records: COHORT }).ctx, andTerm)).toEqual({
			needs: "a filter grammar that can express a combined predicate",
			ok: false,
		})
	})
})

describe("readComposed", () => {
	it("reads each term and the combination once when they agree", async () => {
		const { staged, terms } = planned({ doc: DOC, records: COHORT })
		const composed = await readComposed(staged.ctx, terms, intersect)
		expect(composed).toMatchObject({ expected: new Set(["w-1"]), extra: [], got: new Set(["w-1"]), missing: [] })
		expect(staged.sent).toHaveLength(3)
	})

	it("returns the fresh reads when a disagreement repeats", async () => {
		const { staged, terms } = planned({ behavior: { swap: true }, doc: DOC, records: COHORT })
		const composed = await readComposed(staged.ctx, terms, intersect)
		expect(composed).toMatchObject({ extra: ["w-2", "w-3"], missing: [] })
		expect(filters(staged.sent)).toHaveLength(6)
	})

	it("is rejected, incomplete, or moving as the reads say", async () => {
		const refused = planned({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await readComposed(refused.staged.ctx, refused.terms, intersect)).toBe("rejected")
		const partial = planned({ ...endless(DOC), records: COHORT })
		expect(await readComposed(partial.staged.ctx, partial.terms, intersect)).toBe("incomplete")
		const moved = (after: number) =>
			planned({
				behavior: { swap: true },
				doc: DOC,
				records: COHORT,
				store: growing(COHORT, after, { id: "w-9", name: "alpha", status: "open" }),
			})
		for (const after of [3, 4, 5]) {
			const { staged, terms } = moved(after)
			expect(await readComposed(staged.ctx, terms, intersect)).toBe("moving")
		}
	})

	it("is rejected when the fresh reads are refused", async () => {
		const { staged, terms } = planned({
			behavior: { status: (_query, call) => (call > 3 ? 400 : undefined), swap: true },
			doc: DOC,
			records: COHORT,
		})
		expect(await readComposed(staged.ctx, terms, intersect)).toBe("rejected")
	})
})
