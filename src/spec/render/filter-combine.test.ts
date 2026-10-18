import { describe, expect, it } from "vitest"
import { renderAnd, renderAndOfOr, renderOr } from "./filter-combine.ts"
import { parseFilterGrammar } from "./filter-parse.ts"
import { FILTER_PRESETS } from "./filter-presets.ts"
import type { FilterGrammarSpec, FilterPredicate } from "./filter-types.ts"

const EXAMPLE = {
	combine: "repeat",
	conj: { and: "and", or: "or" },
	list: ",",
	null: { is: "{conj}_{field}_is_null", not: "{conj}_{field}_isn_null" },
	ops: { eq: "eq", gt: "gt", gte: "gte", in: "in", like: "like", lt: "lt", lte: "lte", neq: "ne" },
	or: "terms",
	term: "{conj}_{field}_{op}_{value}",
}

function parsed(raw: unknown): FilterGrammarSpec {
	const result = parseFilterGrammar(raw)
	if (!result.ok) throw new Error(result.error)
	return result.spec
}

const both: readonly FilterPredicate[] = [
	{ field: "Qty", op: "eq", value: "2" },
	{ field: "Name", op: "eq", value: "x" },
]
const unwritable: readonly FilterPredicate[] = [both[0] as FilterPredicate, { field: "Name", op: "ilike", value: "x" }]
const spec = parsed(EXAMPLE)
const postgrest: FilterGrammarSpec = FILTER_PRESETS.postgrest

describe("and", () => {
	it("sends two terms as the parameter repeated, joined, or grouped", () => {
		expect(renderAnd(spec, "filter", both)).toEqual({ filter: ["and_Qty_eq_2", "and_Name_eq_x"] })
		const joined = parsed({ ...EXAMPLE, combine: { join: ";" } })
		expect(renderAnd(joined, "filter", both)).toEqual({ filter: "and_Qty_eq_2;and_Name_eq_x" })
		expect(renderAnd(postgrest, "filter", both)).toEqual({ filter: "and(Qty.eq.2,Name.eq.x)" })
	})

	it("merges distinct parameters when each field is its own", () => {
		const perField = parsed({ ops: { eq: "eq" }, param: "{field}", term: "{value}" })
		expect(renderAnd(perField, undefined, both)).toEqual({ Name: "x", Qty: "2" })
		expect(renderAnd(perField, undefined, unwritable)).toBeNull()
	})

	it("is null without a filter parameter or when a term cannot be written", () => {
		expect(renderAnd(spec, undefined, both)).toBeNull()
		expect(renderAnd(spec, "filter", unwritable)).toBeNull()
	})
})

describe("or", () => {
	it("writes or terms, or an or group", () => {
		expect(renderOr(spec, "filter", both)).toEqual({ filter: ["or_Qty_eq_2", "or_Name_eq_x"] })
		const grouped = parsed({ ...EXAMPLE, or: { group: "or({terms})" } })
		expect(renderOr(grouped, "filter", both)).toEqual({ filter: "or(and_Qty_eq_2,and_Name_eq_x)" })
		expect(renderOr(postgrest, "filter", both)).toEqual({ filter: "or(Qty.eq.2,Name.eq.x)" })
	})

	it("is null where the grammar has no or, no filter parameter, or a term it cannot write", () => {
		const andOnly = parsed({ ...EXAMPLE, conj: { and: "and" }, or: "none" })
		expect(renderOr(andOnly, "filter", both)).toBeNull()
		expect(renderOr(spec, undefined, both)).toBeNull()
		expect(renderOr(spec, "filter", unwritable)).toBeNull()
		expect(
			renderOr(
				postgrest,
				"filter",
				unwritable.map((p) => ({ ...p, op: "is" as const, value: "x" })),
			),
		).toBeNull()
	})
})

describe("and of or", () => {
	it("nests an or group inside an and group where the grammar lets them nest", () => {
		expect(renderAndOfOr(postgrest, "filter", { either: both, first: { field: "a", op: "gt", value: 1 } })).toEqual({
			filter: "and(a.gt.1,or(Qty.eq.2,Name.eq.x))",
		})
	})

	it("is null unless the grammar nests, and when a term cannot be written", () => {
		expect(renderAndOfOr(spec, "filter", { either: both, first: both[0] as FilterPredicate })).toBeNull()
		expect(renderAndOfOr(postgrest, undefined, { either: both, first: both[0] as FilterPredicate })).toBeNull()
		expect(renderAndOfOr(postgrest, "filter", { either: both, first: { field: "a", op: "is", value: 1 } })).toBeNull()
		expect(
			renderAndOfOr(postgrest, "filter", {
				either: [{ field: "b", op: "is", value: "x" }],
				first: both[0] as FilterPredicate,
			}),
		).toBeNull()
	})
})
