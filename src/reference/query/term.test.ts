import { describe, expect, it } from "vitest"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import type { DefectName } from "../defects/table.ts"
import { context, field } from "./__fixtures__/context.ts"
import type { QueryConventions } from "./conventions.ts"
import { buildTerm } from "./term.ts"

const position = field("position")
const term = (op: string, raw: string, defects: DefectName[] = [], conventions: Partial<QueryConventions> = {}) =>
	buildTerm({ ctx: context(defects, conventions), field: position, op, raw })
const cmp = (op: string, value: unknown, extra: object = {}) => ({
	asText: false,
	field: "position",
	kind: "cmp",
	nullsMatch: false,
	op,
	value,
	...extra,
})

describe("buildTerm: arrays", () => {
	it("filters an array by membership, exact or (under the defect) as a substring", () => {
		const tags = field("tags", ROW)
		expect(buildTerm({ ctx: context([], {}, ROW), field: tags, op: "contains", raw: "red" })).toEqual({
			field: "tags",
			kind: "contains",
			substring: false,
			value: "red",
		})
		const loose = buildTerm({
			ctx: context(["CONTAINS_MATCHES_SUBSTRING"], {}, ROW),
			field: tags,
			op: "contains",
			raw: "red",
		})
		expect(loose).toMatchObject({ substring: true })
	})

	it("refuses any other operator on an array, and contains on anything else", () => {
		expect(() => buildTerm({ ctx: context([], {}, ROW), field: field("tags", ROW), op: "eq", raw: "red" })).toThrow(
			'operator "eq" is not supported on "tags"',
		)
		expect(() => term("contains", "1")).toThrow('operator "contains" is not supported on "position"')
	})

	it("refuses an operator no builder knows, such as one an alias table invents", () => {
		expect(() => term("bogus", "1")).toThrow('unhandled operator "bogus"')
		expect(() => term("ne", "1")).toThrow('unhandled operator "ne"')
		expect(() => term("constructor", "1")).toThrow('unhandled operator "constructor"')
	})
})

describe("buildTerm: equality", () => {
	it("compares the typed value, matching nothing for a value of the wrong type", () => {
		expect(term("eq", "2")).toEqual(cmp("eq", 2))
		expect(term("eq", "abc")).toEqual({ kind: "const", value: false })
		expect(() => term("eq", "abc", [], { strictTypes: true })).toThrow('"abc" is not a valid integer for "position"')
	})

	it("matches everything when eq is never applied, and compares as text under the numeric defect", () => {
		expect(term("eq", "2", ["FILTER_EQ_NOT_APPLIED"])).toEqual({ kind: "const", value: true })
		expect(term("eq", "2", ["NUMERIC_COMPARED_AS_TEXT"])).toEqual(cmp("eq", 2, { asText: true }))
		const name = buildTerm({ ctx: context(["NUMERIC_COMPARED_AS_TEXT"]), field: field("name"), op: "eq", raw: "x" })
		expect(name).toMatchObject({ asText: false })
	})

	it("lets nulls through neq, unless the defect drops them", () => {
		expect(term("neq", "2")).toEqual(cmp("neq", 2, { nullsMatch: true }))
		expect(term("neq", "2", ["NEQ_DROPS_NULLS"])).toEqual(cmp("neq", 2))
		expect(term("neq", "abc")).toEqual({ kind: "const", value: true })
		expect(term("neq", "abc", ["NEQ_DROPS_NULLS"])).toEqual({ field: "position", kind: "isnull", negate: true })
	})
})

describe("buildTerm: ranges and patterns", () => {
	it("compares ranges, a defect moving a bound across the boundary", () => {
		expect(term("gt", "2")).toEqual(cmp("gt", 2))
		expect(term("lte", "x")).toEqual({ kind: "const", value: false })
		expect(term("gte", "2", ["FILTER_GTE_IS_GT"])).toEqual(cmp("gt", 2))
		expect(term("lte", "2", ["FILTER_LTE_IS_LT"])).toEqual(cmp("lt", 2))
		expect(term("lt", "2", ["FILTER_LT_IS_LTE"])).toEqual(cmp("lte", 2))
		expect(term("gte", "2", ["FILTER_LTE_IS_LT", "FILTER_LT_IS_LTE"])).toEqual(cmp("gte", 2))
	})

	it("matches like and ilike on text only, case folded for ilike unless the defect drops it", () => {
		const name = field("name", TABLE)
		const like = (op: string, defects: DefectName[] = []) =>
			buildTerm({ ctx: context(defects), field: name, op, raw: "a%*" })
		expect(like("like")).toEqual({
			field: "name",
			insensitive: false,
			kind: "like",
			pattern: [{ kind: "text", text: "a%" }, { kind: "any" }],
		})
		expect(like("ilike")).toMatchObject({ insensitive: true })
		expect(like("ilike", ["FILTER_ILIKE_IS_LIKE"])).toMatchObject({ insensitive: false })
		expect(like("like", ["LIKE_UNESCAPED"])).toMatchObject({
			pattern: [{ kind: "text", text: "a" }, { kind: "any" }, { kind: "any" }],
		})
		expect(() => term("like", "1")).toThrow("like needs a text field")
	})

	it("hands in and is to their own builders", () => {
		expect(term("in", "(1,2)")).toMatchObject({ kind: "in", values: [1, 2] })
		expect(term("is", "null")).toEqual({ field: "position", kind: "isnull", negate: false })
	})
})
