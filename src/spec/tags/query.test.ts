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

describe("xQuery's sort, select and searchCase", () => {
	it("accepts the blocks as docs/tags.md writes them", () => {
		const sort = {
			collation: "binary",
			defaultNulls: "last",
			defaultOrder: "-created_at",
			maxKeys: 3,
			nulls: ["first"],
		}
		const select = { nested: false, relations: [{ fields: ["id", "name"], name: "owner" }], unknown: "ignore" }
		expect(xQuery({ searchCase: "insensitive", select, sort })).toBeNull()
	})

	it("names the key a malformed block or value is under", () => {
		expect(xQuery({ sort: "name" })).toBe('"sort" must be an object')
		expect(xQuery({ sort: { maxKeys: 0 } })).toBe('"sort" "maxKeys" must be a positive integer')
		expect(xQuery({ sort: { collation: "ascii" } })).toMatch(/^"sort" "collation" must be one of/)
		expect(xQuery({ select: { nested: "yes" } })).toMatch(/^"select" "nested" /)
		expect(xQuery({ select: { relations: [{ name: "owner" }] } })).toMatch(/^"select" "relations" /)
		expect(xQuery({ select: { relations: "owner" } })).toBe(
			'"select" "relations" must be an array of { name, fields } rows',
		)
		expect(xQuery({ searchCase: "loose" })).toBe('"searchCase" must be one of "sensitive", "insensitive"')
	})
})
