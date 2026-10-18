import { describe, expect, it } from "vitest"
import { FILTER_PRESETS } from "../render/filter-presets.ts"
import { parseFilterGrammar } from "../render/filter-parse.ts"
import { andTerm, canWriteFilterOp, filterFragment, filterSpec, filterTerm, orTerm } from "./filter.ts"
import type { FilterGrammar, QueryConventions } from "./types.ts"

const at = (grammar: FilterGrammar, extra: Partial<QueryConventions> = {}): QueryConventions => ({
	envelope: {},
	filter: "filter",
	grammar,
	selectGrammar: "csv",
	sortGrammar: "dotted",
	...extra,
})

const parsed = parseFilterGrammar({ ops: { eq: "is" }, term: "{field}[{op}]={value}" })
if (!parsed.ok) throw new Error(parsed.error)
const template = at("template", { filterGrammar: parsed.spec })

describe("filterSpec", () => {
	it("is a named grammar's preset, or the declared template", () => {
		expect(filterSpec(at("postgrest"))).toBe(FILTER_PRESETS.postgrest)
		expect(filterSpec(template)).toBe(parsed.spec)
	})

	it("refuses a template grammar that lost its template", () => {
		expect(() => filterSpec(at("template"))).toThrow("a template grammar without its template")
	})
})

describe("filter terms", () => {
	it("render one predicate in the endpoint's grammar, or say it cannot be written", () => {
		expect(canWriteFilterOp(at("postgrest"), "gt")).toBe(true)
		expect(canWriteFilterOp(at("equality"), "gt")).toBe(false)
		expect(filterTerm(at("postgrest"), { field: "qty", op: "gt", value: 5 })).toEqual({ filter: "qty.gt.5" })
		expect(filterTerm(template, { field: "qty", op: "eq", value: "a" })).toEqual({ filter: "qty[is]=a" })
		expect(
			filterTerm(at("postgrest", { filter: undefined } as never), { field: "qty", op: "eq", value: "a" }),
		).toBeNull()
	})

	it("give the bare text of an equality term", () => {
		expect(filterFragment(at("postgrest"), "qty", "2")).toBe("qty.eq.2")
		expect(filterFragment(at("equality"), "qty", "2")).toBe("2")
		expect(filterFragment(at("unrecognised"), "qty", "2")).toBeNull()
	})

	it("join two equalities with the grammar's and, and its or where it has one", () => {
		const a = { field: "qty", value: "2" }
		const b = { field: "name", value: "x" }
		expect(andTerm(at("postgrest"), a, b)).toEqual({ filter: "and(qty.eq.2,name.eq.x)" })
		expect(orTerm(at("postgrest"), a, b)).toEqual({ filter: "or(qty.eq.2,name.eq.x)" })
		expect(orTerm(at("colon"), a, b)).toBeNull()
	})
})
