import { describe, expect, it } from "vitest"
import { ROW } from "../model/row.ts"
import { context } from "./__fixtures__/context.ts"
import { parseFilter } from "./filter.ts"

const terms = (count: number): string =>
	`and(${Array.from({ length: count }, (_, i) => `position.neq.${i}`).join(",")})`
const status = (value: string) => ({ asText: false, field: "status", kind: "cmp", nullsMatch: false, op: "eq", value })

describe("parseFilter: terms", () => {
	it("parses a term into a comparison on the field, the value read whole", () => {
		expect(parseFilter(" status.eq.active ", context())).toEqual(status("active"))
		expect(parseFilter("name.eq.a.b", context())).toEqual({ ...status("a.b"), field: "name" })
	})

	it("refuses a term without an operator and a value, or drops it under the defect", () => {
		expect(() => parseFilter("name.eq", context())).toThrow('malformed filter term "name.eq"')
		expect(parseFilter("name", context(["IGNORES_MALFORMED_FILTER"]))).toEqual({ kind: "const", value: true })
	})

	it("drops a term whose operator a defect ignores", () => {
		expect(parseFilter("name.zz.1", context(["FILTER_ILLEGAL_OP_IGNORED"]))).toEqual({ kind: "const", value: true })
	})

	it("refuses a field that is not filterable, or drops it under the defect", () => {
		expect(() => parseFilter("bogus.eq.1", context())).toThrow('field "bogus" is not filterable')
		expect(parseFilter("bogus.eq.1", context(["FILTER_IGNORED"]))).toEqual({ kind: "const", value: true })
		expect(() => parseFilter("created_at.eq.1", context(["SPEC_OVERCLAIMS_FILTERABLE"]))).toThrow(
			'field "created_at" is not filterable',
		)
	})
})

describe("parseFilter: the condition cap", () => {
	it("refuses more conditions than the catalog allows, unless the cap is ignored", () => {
		expect(parseFilter(terms(20), context()).kind).toBe("and")
		expect(() => parseFilter(terms(21), context())).toThrow("more than 20 filter conditions")
		expect(parseFilter(terms(21), context(["FILTER_CONDITION_CAP_IGNORED"])).kind).toBe("and")
	})

	it("has no cap on an entity without a catalog", () => {
		expect(parseFilter(terms(30).replaceAll("position", "amount"), context([], {}, ROW)).kind).toBe("and")
	})
})

describe("parseFilter: groups", () => {
	it("joins a group's terms with its combinator, nested groups kept", () => {
		expect(parseFilter("or(status.eq.a,and(status.eq.b,status.eq.c))", context())).toEqual({
			children: [status("a"), { children: [status("b"), status("c")], kind: "and" }],
			kind: "or",
		})
	})

	it("refuses an empty group", () => {
		expect(() => parseFilter("and()", context())).toThrow("empty and() group")
		expect(() => parseFilter("or( , )", context())).toThrow("empty or() group")
	})

	it("swaps the joiner, not the parse, under the swapped-combinator defect", () => {
		const swapped = context(["FILTER_GROUP_COMBINATOR_SWAPPED"])
		expect(parseFilter("and(status.eq.a,status.eq.b)", swapped)).toMatchObject({ kind: "or" })
		expect(parseFilter("or(status.eq.a,status.eq.b)", swapped)).toMatchObject({ kind: "and" })
	})

	it("lets the last nested group's joiner decide the enclosing one under the leak", () => {
		const leaks = context(["FILTER_NESTED_COMBINATOR_LEAKS"])
		expect(parseFilter("and(status.eq.a,or(status.eq.b,status.eq.c))", leaks)).toMatchObject({ kind: "or" })
		expect(parseFilter("or(and(status.eq.a,status.eq.b),status.eq.c)", leaks)).toMatchObject({ kind: "and" })
		expect(parseFilter("and(status.eq.a,status.eq.b)", leaks)).toMatchObject({ kind: "and" })
	})
})
