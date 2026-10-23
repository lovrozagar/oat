import { describe, expect, it } from "vitest"
import { MissingValueError } from "../../errors/missing-value.ts"
import { FILTER_PRESETS } from "./filter-presets.ts"
import { parseFilterGrammar } from "./filter-parse.ts"
import { canGroupAnd, canWriteOp, canWriteOr, fill, renderFragment, renderTerm, scalar } from "./filter-term.ts"
import type { FilterGrammarSpec, FilterTermValue } from "./filter-types.ts"

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

function parsed(raw: unknown): FilterGrammarSpec {
	const result = parseFilterGrammar(raw)
	if (!result.ok) throw new Error(result.error)
	return result.spec
}

const postgrest: FilterGrammarSpec = FILTER_PRESETS.postgrest

describe("what a grammar can write", () => {
	it("writes an operator only with its token, a list for in and nin, and null terms for is", () => {
		const spec = parsed(EXAMPLE)
		expect(canWriteOp(spec, "ilike")).toBe(false)
		expect(canWriteOp(spec, "nin")).toBe(false)
		expect(canWriteOp(spec, "in")).toBe(true)
		expect(canWriteOp(spec, "is")).toBe(true)
		expect(canWriteOp(parsed({ ops: { eq: "eq", in: "in" }, term: "{field}.{op}.{value}" }), "in")).toBe(false)
		expect(canWriteOp(FILTER_PRESETS.colon, "is")).toBe(false)
	})

	it("groups and only where a group template exists, and writes or only through a filter parameter", () => {
		expect(canGroupAnd(postgrest)).toBe(true)
		expect(canGroupAnd(FILTER_PRESETS.colon)).toBe(false)
		expect(canGroupAnd(parsed(EXAMPLE))).toBe(false)
		expect(canWriteOr(postgrest)).toBe(true)
		expect(canWriteOr(FILTER_PRESETS.colon)).toBe(false)
		expect(canWriteOr({ ...postgrest, param: "field" })).toBe(false)
	})
})

describe("placeholders and values", () => {
	it("fills every placeholder, or is null when one is missing", () => {
		expect(fill("{field}.{op}.{value}", { field: "a", op: "eq", value: "1" })).toBe("a.eq.1")
		expect(fill("{conj}_{field}", { field: "a" })).toBeNull()
		expect(fill("{field}$&", { field: "$1" })).toBe("$1$&")
	})

	it("escapes a value, refusing one that already holds a replacement or a reserved character", () => {
		const escaping = { ...postgrest, escape: { _: "~" }, reserved: "," }
		expect(scalar(escaping, "a_b")).toBe("a~b")
		expect(scalar(escaping, "a~b")).toBeNull()
		expect(scalar(escaping, "a,b")).toBeNull()
		expect(scalar(escaping, null)).toBe("null")
		expect(scalar(escaping, 2)).toBe("2")
		expect(scalar(escaping, false)).toBe("false")
	})

	it("refuses to write a missing value as text", () => {
		expect(() => scalar(postgrest, undefined as unknown as string)).toThrow(MissingValueError)
		const value = undefined as unknown as string
		expect(() => renderTerm(FILTER_PRESETS.colon, "filter", { field: "ID", op: "eq", value })).toThrow(
			MissingValueError,
		)
	})
})

describe("a template grammar", () => {
	const spec = parsed(EXAMPLE)
	const term = (field: string, op: Parameters<typeof canWriteOp>[1], value: unknown) =>
		renderTerm(spec, "filter", { field, op, value: value as FilterTermValue })

	it("writes one term per predicate with its own operator tokens", () => {
		expect(term("Qty", "eq", 2)).toEqual({ filter: "and_Qty_eq_2" })
		expect(term("Qty", "neq", 2)).toEqual({ filter: "and_Qty_ne_2" })
		expect(term("Qty", "is", null)).toEqual({ filter: "and_Qty_is_null" })
		expect(term("Qty", "is", "notnull")).toEqual({ filter: "and_Qty_isn_null" })
		expect(term("Qty", "is", "not.null")).toEqual({ filter: "and_Qty_isn_null" })
		expect(term("Qty", "is", "true")).toBeNull()
		expect(term("Qty", "in", [1, 2])).toEqual({ filter: "and_Qty_in_1,2" })
		expect(term("Qty", "in", 1)).toEqual({ filter: "and_Qty_in_1" })
	})

	it("cannot write an operator it does not list, or a list where one value goes", () => {
		expect(term("Qty", "ilike", "a")).toBeNull()
		expect(term("Qty", "eq", [1, 2])).toBeNull()
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

	it("writes an or term only where the grammar has an or token", () => {
		expect(renderFragment(spec, { field: "Qty", op: "eq", value: 2 }, "or")).toBe("or_Qty_eq_2")
		const andOnly = parsed({ ...EXAMPLE, conj: { and: "and" }, or: "none" })
		expect(renderFragment(andOnly, { field: "Qty", op: "eq", value: 2 }, "or")).toBeNull()
		expect(renderFragment(andOnly, { field: "Qty", op: "is", value: null }, "or")).toBeNull()
	})

	it("puts each term in a parameter named after its field when told to", () => {
		const perField = parsed({ ops: { eq: "eq", gt: "gt" }, param: "{field}", term: "{op}:{value}" })
		expect(renderTerm(perField, undefined, { field: "Qty", op: "gt", value: 2 })).toEqual({ Qty: "gt:2" })
		expect(renderTerm(perField, undefined, { field: "Qty", op: "in", value: [2] })).toBeNull()
	})

	it("needs a filter parameter otherwise", () => {
		expect(renderTerm(spec, undefined, { field: "Qty", op: "eq", value: 2 })).toBeNull()
	})
})

describe("postgrest", () => {
	it("writes lists in parentheses, an empty list included", () => {
		expect(renderTerm(postgrest, "f", { field: "s", op: "in", value: ["a", "b"] })).toEqual({ f: "s.in.(a,b)" })
		expect(renderTerm(postgrest, "f", { field: "s", op: "nin", value: [] })).toEqual({ f: "s.nin.()" })
		expect(renderTerm(postgrest, "f", { field: "s", op: "is", value: "null" })).toEqual({ f: "s.is.null" })
	})
})
