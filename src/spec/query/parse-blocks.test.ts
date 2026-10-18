import { describe, expect, it } from "vitest"
import { parseFilterableFrom, parseSelectBlock, parseSortBlock } from "./parse-blocks.ts"

describe("sort block", () => {
	it("reads the block, in the catalog's key order", () => {
		const sort = parseSortBlock({
			sort: {
				collation: "locale",
				defaultNulls: "first",
				defaultOrder: "created_at.desc",
				maxKeys: 3.7,
				nulls: ["first", "nope", 1],
				stableTiebreak: "id",
			},
		})
		expect(sort).toEqual({
			collation: "locale",
			defaultNulls: "first",
			defaultOrder: "created_at.desc",
			maxKeys: 3,
			nulls: ["first"],
			stableTiebreak: "id",
		})
		expect(Object.keys(sort ?? {})).toEqual([
			"collation",
			"defaultNulls",
			"defaultOrder",
			"stableTiebreak",
			"nulls",
			"maxKeys",
		])
	})

	it("falls back to the flat keys, and the block wins", () => {
		expect(
			parseSortBlock({
				defaultOrder: "name.asc",
				maxSortKeys: 2,
				sortCollation: "binary",
				sortDefaultNulls: "last",
				sortNulls: ["last"],
				stableTiebreak: "id",
			}),
		).toEqual({
			collation: "binary",
			defaultNulls: "last",
			defaultOrder: "name.asc",
			maxKeys: 2,
			nulls: ["last"],
			stableTiebreak: "id",
		})
		expect(parseSortBlock({ defaultOrder: "flat", sort: { defaultOrder: "block" } })?.defaultOrder).toBe("block")
		expect(parseSortBlock({ defaultOrder: "flat", sort: { defaultOrder: 1 } })?.defaultOrder).toBe("flat")
		expect(parseSortBlock({ sort: { defaultOrder: "" }, defaultOrder: "flat" })).toBeUndefined()
	})
})

describe("sort block: what does not validate", () => {
	it("drops what does not validate, and an empty block", () => {
		expect(parseSortBlock({ sort: null })).toBeUndefined()
		expect(parseSortBlock({ sort: [] })).toBeUndefined()
		expect(
			parseSortBlock({
				sort: { collation: "nope", defaultNulls: "middle", maxKeys: 0, nulls: "first", stableTiebreak: "" },
			}),
		).toBeUndefined()
		expect(
			parseSortBlock({ sortDefaultNulls: 1, maxSortKeys: Number.POSITIVE_INFINITY, sortNulls: ["nope"] }),
		).toBeUndefined()
		expect(parseSortBlock({ sortCollation: "case-insensitive" })).toEqual({ collation: "case-insensitive" })
	})
})

describe("select block", () => {
	it("reads the block and its relations", () => {
		expect(
			parseSelectBlock({
				select: {
					nested: true,
					relations: [{ fields: ["id", 1], name: "owner" }, null, 1, { fields: [], name: 1 }, { name: "x" }],
					unknown: "reject",
				},
			}),
		).toEqual({ nested: true, relations: [{ fields: ["id"], name: "owner" }], unknown: "reject" })
	})

	it("falls back to the flat keys and drops an empty block", () => {
		expect(parseSelectBlock({ selectNested: false, selectUnknown: "ignore" })).toEqual({
			nested: false,
			unknown: "ignore",
		})
		expect(parseSelectBlock({ select: { nested: "yes", relations: [null], unknown: "maybe" } })).toBeUndefined()
		expect(parseSelectBlock({ select: [] })).toBeUndefined()
	})
})

describe("harvest source", () => {
	it("reads an operation, a route, a type path and a type map", () => {
		expect(
			parseFilterableFrom({
				operationId: "table.get",
				path: "$.columns[*].name",
				typeMap: { nope: "blob", text: "string" },
				typePath: "$.columns[*].type",
			}),
		).toEqual({
			operationId: "table.get",
			path: "$.columns[*].name",
			typeMap: { text: "string" },
			typePath: "$.columns[*].type",
		})
		expect(parseFilterableFrom({ operationId: "GET /v1/meta", path: "$.s" })).toEqual({
			path: "$.s",
			route: "GET /v1/meta",
		})
		expect(parseFilterableFrom({ operationId: "/v1/meta", path: "$.x" })).toEqual({ path: "$.x", route: "/v1/meta" })
		expect(parseFilterableFrom({ operationId: "a", path: "$.s", route: "GET /b" })).toEqual({
			operationId: "a",
			path: "$.s",
			route: "GET /b",
		})
	})

	it("is absent without a path, and ignores empty or malformed extras", () => {
		expect(parseFilterableFrom(null)).toBeUndefined()
		expect(parseFilterableFrom([])).toBeUndefined()
		expect(parseFilterableFrom({ path: "" })).toBeUndefined()
		expect(parseFilterableFrom({ path: 1 })).toBeUndefined()
		expect(parseFilterableFrom({ operationId: "", path: "$.p", route: "", typeMap: [], typePath: "" })).toEqual({
			path: "$.p",
		})
	})
})
