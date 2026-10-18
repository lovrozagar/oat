import { describe, expect, it } from "vitest"
import { xQuery } from "./query.ts"

describe("xQuery", () => {
	it("accepts a well-formed tag", () => {
		expect(
			xQuery({
				aliases: { q: "search" },
				emptyIn: "match-none",
				filterable: ["id", { field: "name", ops: ["eq", "like"], type: "string" }],
				filterableFrom: { operationId: "table.get", path: "$.columns[*].name" },
				grammar: { ops: { eq: "eq" }, term: "{field}[{op}]={value}" },
				maxLimit: 100,
				operatorsByType: { string: ["eq"] },
				searchable: null,
				selectNested: true,
				sortCollation: "case-insensitive",
				sortGrammar: { asc: "a", desc: "d", term: "{field}:{direction}" },
				sortable: [{ field: "name", nulls: ["first"] }],
			}),
		).toBeNull()
		expect(xQuery({ grammar: "postgrest", sortGrammar: "prefixed" })).toBeNull()
	})

	it("names the field that is wrong, and what is wrong with it", () => {
		expect(xQuery("x")).toBe("must be an object")
		expect(xQuery({ grammar: "bogus" })).toBe('"grammar" must be one of "postgrest", "colon", "equality"')
		expect(xQuery({ grammar: { term: 1 } })).toMatch(/^"grammar" is a template oat cannot read: /)
		expect(xQuery({ sortGrammar: "up" })).toBe('"sortGrammar" must be one of "dotted", "prefixed", "colon", "spaced"')
		expect(xQuery({ sortGrammar: { term: 1 } })).toMatch(/^"sortGrammar" is a template oat cannot read: /)
		expect(xQuery({ filterable: 5 })).toMatch(/"filterable" must be an array/)
		expect(xQuery({ maxLimit: "x" })).toBe('"maxLimit" must be a positive integer')
		expect(xQuery({ sortable: [{ type: "date" }] })).toBe('"sortable" has a row that needs "field"')
		expect(xQuery({ selectable: [{ field: 1 }] })).toBe(
			'"selectable" has a row that "field" must be a non-empty string',
		)
		expect(xQuery({ searchableFrom: { path: "$.a" } })).toBe('"searchableFrom" needs "operationId"')
		expect(xQuery({ operatorsByType: { string: [1] } })).toBe(
			'"operatorsByType" must map type names to arrays of operators',
		)
		expect(xQuery({ operatorsByType: [] })).toBe('"operatorsByType" must map type names to arrays of operators')
	})

	it("holds every enumerated field to its values", () => {
		const fields = [
			"emptyIn",
			"limitOutOfRange",
			"searchEmpty",
			"selectUnknown",
			"sortCollation",
			"sortDefaultNulls",
		] as const
		for (const field of fields) expect(xQuery({ [field]: "nope" })).toMatch(new RegExp(`^"${field}" must be one of`))
	})
})
