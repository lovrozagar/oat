import { describe, expect, it } from "vitest"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import type { ParseContext } from "./conventions.ts"
import { context, field, termRead } from "./__fixtures__/context.ts"
import { isTerm, listTerm } from "./term-list.ts"

const list = (op: string, raw: string, ctx: ParseContext = context()) =>
	listTerm(termRead({ ctx, field: field("status"), op, raw }))

/* Every value but "x" is of the field's type. */
const typed = (text: string) => (text === "x" ? undefined : text)
const is = (raw: string, name = "description", ctx: ParseContext = context()) =>
	isTerm(termRead({ ctx, field: field(name, ctx.entity), op: "is", raw }))

describe("listTerm", () => {
	it("tests membership in a parenthesized list, blanks dropped", () => {
		expect(list("in", "(a, ,b)")).toEqual({
			asText: false,
			field: "status",
			kind: "in",
			negate: false,
			values: ["a", "b"],
		})
		expect(list("nin", "a,b")).toMatchObject({ negate: true, values: ["a", "b"] })
	})

	it("matches nothing for an empty in() and everything for an empty nin(), or refuses where the catalog says so", () => {
		expect(list("in", "()")).toEqual({ kind: "const", value: false })
		expect(list("nin", "")).toEqual({ kind: "const", value: true })
		const strict = { ...TABLE, filterCatalog: { emptyIn: "reject" as const } }
		expect(() => list("in", "()", context([], {}, strict))).toThrow("empty in()")
	})

	it("refuses more values than the catalog allows, unless the cap is ignored", () => {
		const many = `(${Array.from({ length: 101 }, (_, i) => i).join(",")})`
		expect(() => list("in", many)).toThrow("in() exceeds maxInValues=100")
		expect(list("in", many, context(["FILTER_IN_CAP_IGNORED"]))).toMatchObject({ kind: "in" })
		expect(list("in", many, context([], {}, ROW))).toMatchObject({ kind: "in" })
	})

	it("keeps only the values of the field's type, and only the first under the first-only defects", () => {
		const read = termRead({ field: field("status"), op: "in", raw: "(a,x,b)", typed })
		expect(listTerm(read)).toMatchObject({ values: ["a", "b"] })
		expect(list("in", "(a,b)", context(["FILTER_IN_FIRST_ONLY"]))).toMatchObject({ values: ["a"] })
		expect(list("nin", "(a,b)", context(["FILTER_IN_FIRST_ONLY"]))).toMatchObject({ values: ["a", "b"] })
		expect(list("nin", "(a,b)", context(["FILTER_NIN_FIRST_ONLY"]))).toMatchObject({ values: ["a"] })
		expect(list("in", "(a,b)", context(["FILTER_NIN_FIRST_ONLY"]))).toMatchObject({ values: ["a", "b"] })
	})
})

describe("isTerm", () => {
	it("tests for null, or matches every row under the defect", () => {
		expect(is("null")).toEqual({ field: "description", kind: "isnull", negate: false })
		expect(is("null", "description", context(["FILTER_IS_NULL_MATCHES_ALL"]))).toEqual({ kind: "const", value: true })
		expect(is("notnull")).toEqual({ field: "description", kind: "isnull", negate: true })
		expect(is("not.null")).toEqual({ field: "description", kind: "isnull", negate: true })
	})

	it("reads true and false as equality on a boolean, and refuses anything else", () => {
		expect(is("true", "active", context([], {}, ROW))).toEqual({
			asText: false,
			field: "active",
			kind: "cmp",
			nullsMatch: false,
			op: "eq",
			value: true,
		})
		expect(is("false", "active", context([], {}, ROW))).toMatchObject({ value: false })
		expect(() => is("true")).toThrow("is.true is not a recognized predicate")
		expect(() => is("maybe", "active", context([], {}, ROW))).toThrow("is.maybe is not a recognized predicate")
	})
})
