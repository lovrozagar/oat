import { describe, expect, it } from "vitest"
import { canWriteOp, parseFilterGrammar, renderAnd, renderAndOfOr, renderOr, renderTerm } from "./filter-render.ts"

/*
 * A grammar oat has no name for, declared as a template. The example is the one term per value
 * grammar seen in the wild: `and_Qty_eq_2`, `ne` for not-equal, null tests as their own terms,
 * `in` values joined by a comma, and terms sent as a repeated parameter.
 */

const EXAMPLE = {
	combine: "repeat",
	conj: { and: "and", or: "or" },
	list: ",",
	null: { is: "{conj}_{field}_is_null", not: "{conj}_{field}_isn_null" },
	ops: { eq: "eq", gt: "gt", gte: "gte", in: "in", like: "like", lt: "lt", lte: "lte", neq: "ne" },
	or: "terms",
	term: "{conj}_{field}_{op}_{value}",
}

function parsed(raw: unknown) {
	const result = parseFilterGrammar(raw)
	if (!result.ok) throw new Error(result.error)
	return result.spec
}

describe("parseFilterGrammar", () => {
	it("reads the template form", () => {
		const spec = parsed(EXAMPLE)
		expect(spec.and).toBe("repeat")
		expect(spec.or).toBe("terms")
		expect(spec.likeWildcard).toBe("%")
		expect(spec.mixed).toBe(false)
		expect(spec.param).toBe("filter")
	})

	it("names the key it cannot read", () => {
		for (const [raw, key] of [
			[{ ...EXAMPLE, term: "{conj}_{field}_{op}" }, "term"],
			[{ ...EXAMPLE, ops: { eq: "" } }, "ops.eq"],
			[{ ...EXAMPLE, ops: { approx: "~" } }, "ops.approx"],
			[{ ...EXAMPLE, combine: "sometimes" }, "combine"],
			[{ ...EXAMPLE, mixed: true }, "mixed"],
			[{ ...EXAMPLE, conj: undefined }, "conj"],
			[{ ...EXAMPLE, conj: { and: "and" } }, "or"],
			[{ ...EXAMPLE, likeMatches: "glob" }, "likeMatches"],
			[{ ...EXAMPLE, escape: { __: "~" } }, "escape"],
			[{ ...EXAMPLE, or: { group: "or({field})" } }, "or"],
		] as const) {
			const result = parseFilterGrammar(raw)
			expect(result.ok, key).toBe(false)
			if (!result.ok) expect(result.error).toContain(key)
		}
	})
})

describe("a template grammar", () => {
	const spec = parsed(EXAMPLE)
	const term = (field: string, op: Parameters<typeof canWriteOp>[1], value: unknown) =>
		renderTerm(spec, "filter", { field, op, value: value as never })

	it("writes one term per predicate with its own operator tokens", () => {
		expect(term("Qty", "eq", 2)).toEqual({ filter: "and_Qty_eq_2" })
		expect(term("Qty", "neq", 2)).toEqual({ filter: "and_Qty_ne_2" })
		expect(term("Qty", "is", null)).toEqual({ filter: "and_Qty_is_null" })
		expect(term("Qty", "is", "notnull")).toEqual({ filter: "and_Qty_isn_null" })
		expect(term("Qty", "in", [1, 2])).toEqual({ filter: "and_Qty_in_1,2" })
	})

	it("cannot write an operator it does not list", () => {
		expect(canWriteOp(spec, "ilike")).toBe(false)
		expect(canWriteOp(spec, "nin")).toBe(false)
		expect(term("Qty", "ilike", "a")).toBeNull()
	})

	it("refuses a value that would read as another term, unless the grammar escapes it", () => {
		expect(term("Name", "eq", "a_b")).toBeNull()
		expect(term("Name", "in", ["a,b", "c"])).toBeNull()
		expect(term("Name", "in", [])).toBeNull()
		const escaped = parsed({ ...EXAMPLE, escape: { _: "~" } })
		expect(renderTerm(escaped, "filter", { field: "Name", op: "eq", value: "a_b" })).toEqual({
			filter: "and_Name_eq_a~b",
		})
		expect(renderTerm(escaped, "filter", { field: "Name", op: "eq", value: "a~b" })).toBeNull()
	})

	it("sends two terms as the parameter repeated, or joined when it says so", () => {
		const both = [
			{ field: "Qty", op: "eq", value: "2" },
			{ field: "Name", op: "eq", value: "x" },
		] as const
		expect(renderAnd(spec, "filter", both)).toEqual({ filter: ["and_Qty_eq_2", "and_Name_eq_x"] })
		const joined = parsed({ ...EXAMPLE, combine: { join: ";" } })
		expect(renderAnd(joined, "filter", both)).toEqual({ filter: "and_Qty_eq_2;and_Name_eq_x" })
		expect(renderTerm(joined, "filter", { field: "Name", op: "eq", value: "a;b" })).toBeNull()
		expect(renderOr(spec, "filter", both)).toEqual({ filter: ["or_Qty_eq_2", "or_Name_eq_x"] })
	})

	it("has no or and never nests and with or unless it says how", () => {
		const both = [
			{ field: "Qty", op: "eq", value: "2" },
			{ field: "Name", op: "eq", value: "x" },
		] as const
		const andOnly = parsed({ ...EXAMPLE, conj: { and: "and" }, or: "none" })
		expect(renderOr(andOnly, "filter", both)).toBeNull()
		expect(renderAndOfOr(spec, "filter", both[0], both)).toBeNull()
		const grouped = parsed({ ...EXAMPLE, or: { group: "or({terms})" } })
		expect(renderOr(grouped, "filter", both)).toEqual({ filter: "or(and_Qty_eq_2,and_Name_eq_x)" })
	})

	it("reads like as a pattern unless it declares a substring match", () => {
		expect(parsed({ ...EXAMPLE, likeMatches: "contains" }).likeWildcard).toBeNull()
	})

	it("puts each term in a parameter named after its field when told to", () => {
		const perField = parsed({ ops: { eq: "eq", gt: "gt" }, param: "{field}", term: "{op}:{value}" })
		expect(perField.and).toBe("params")
		expect(renderTerm(perField, undefined, { field: "Qty", op: "gt", value: 2 })).toEqual({ Qty: "gt:2" })
	})
})
