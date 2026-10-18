import { describe, expect, it } from "vitest"
import { parseQueryCatalog } from "./parse-catalog.ts"

/* Every key a tag may hold, some entries of each malformed. */
const FULL_TAG = {
	aliases: { eq: 1, ne: "neq", nope: "eq" },
	emptyIn: "match-none",
	filterable: [{ field: "id", ops: ["eq"], type: "string" }],
	filterableFrom: {
		operationId: "table.get",
		path: "$.columns[*].name",
		typeMap: { nope: "blob", text: "string" },
		typePath: "$.columns[*].type",
	},
	identityFilter: "_id",
	limitOutOfRange: "clamp",
	maxFilterConditions: 20.8,
	maxInValues: 100,
	operators: ["eq", "in", "nope"],
	operatorsByType: { nope: ["eq"], number: "eq", string: ["eq", "like"] },
	searchCase: "insensitive",
	searchEmpty: "reject",
	searchModes: ["keyword", "", 1],
	searchable: ["name", 1],
	searchableFrom: { operationId: "GET /v1/meta", path: "$.s" },
	select: {
		nested: true,
		relations: [{ fields: ["id", 1], name: "owner" }, null, { fields: [], name: 1 }, { name: "x" }],
		unknown: "reject",
	},
	selectable: ["id", 1],
	selectableFrom: { path: "$.cols" },
	sort: { defaultOrder: "created_at.desc", maxKeys: 3, nulls: ["first"], stableTiebreak: "id" },
	sortable: [{ field: "created_at", nulls: ["last"] }],
	sortableFrom: { path: "$.s", route: "GET /v1/meta" },
}

/* What the catalog keeps of it. */
const FULL_CATALOG = {
	aliases: { ne: "neq" },
	emptyIn: "match-none",
	filterable: [{ field: "id", ops: ["eq"], type: "string" }],
	filterableFrom: {
		operationId: "table.get",
		path: "$.columns[*].name",
		typeMap: { text: "string" },
		typePath: "$.columns[*].type",
	},
	identityFilter: "_id",
	limitOutOfRange: "clamp",
	maxFilterConditions: 20,
	maxInValues: 100,
	operators: ["eq", "in"],
	operatorsByType: { string: ["eq", "like"] },
	searchCase: "insensitive",
	searchEmpty: "reject",
	searchModes: ["keyword"],
	searchable: ["name"],
	searchableFrom: { path: "$.s", route: "GET /v1/meta" },
	select: { nested: true, relations: [{ fields: ["id"], name: "owner" }], unknown: "reject" },
	selectable: ["id"],
	selectableFrom: { path: "$.cols" },
	sort: { defaultOrder: "created_at.desc", maxKeys: 3, nulls: ["first"], stableTiebreak: "id" },
	sortable: [{ field: "created_at", nulls: ["last"] }],
	sortableFrom: { path: "$.s", route: "GET /v1/meta" },
}

/* The order the catalog lists its keys in. */
const KEY_ORDER = [
	"filterable",
	"sortable",
	"searchable",
	"selectable",
	"operators",
	"operatorsByType",
	"aliases",
	"identityFilter",
	"emptyIn",
	"limitOutOfRange",
	"maxInValues",
	"maxFilterConditions",
	"searchModes",
	"searchEmpty",
	"searchCase",
	"sort",
	"select",
	"filterableFrom",
	"sortableFrom",
	"searchableFrom",
	"selectableFrom",
]

describe("x-query catalog", () => {
	it("parses the full structured catalog and ignores invalid extras", () => {
		const catalog = parseQueryCatalog(FULL_TAG)
		expect(catalog).toEqual(FULL_CATALOG)
		expect(Object.keys(catalog)).toEqual(KEY_ORDER)
	})
})

describe("x-query catalog: flat keys and junk", () => {
	it("accepts searchable: null and flat sort/select keys", () => {
		const catalog = parseQueryCatalog({
			defaultOrder: "name.asc",
			emptyIn: "reject",
			limitOutOfRange: "reject",
			maxFilterConditions: 0,
			maxInValues: Number.NaN,
			maxSortKeys: 2,
			searchCase: "sensitive",
			searchEmpty: "ignore",
			searchable: null,
			selectNested: false,
			selectUnknown: "ignore",
			sortNulls: ["last"],
			stableTiebreak: "id",
		})
		expect(catalog.searchable).toBeNull()
		expect(catalog.emptyIn).toBe("reject")
		expect(catalog.limitOutOfRange).toBe("reject")
		expect(catalog.maxInValues).toBeUndefined()
		expect(catalog.maxFilterConditions).toBeUndefined()
		expect(catalog.searchCase).toBe("sensitive")
		expect(catalog.searchEmpty).toBe("ignore")
		expect(catalog.sort).toEqual({ defaultOrder: "name.asc", maxKeys: 2, nulls: ["last"], stableTiebreak: "id" })
		expect(catalog.select).toEqual({ nested: false, unknown: "ignore" })
	})

	it("leaves out every key that does not validate", () => {
		expect(
			parseQueryCatalog({
				aliases: [],
				defaultOrder: "",
				emptyIn: "sometimes",
				filterableFrom: { path: "" },
				identityFilter: "",
				limitOutOfRange: "wrap",
				maxFilterConditions: "3",
				operatorsByType: null,
				searchCase: "loud",
				searchEmpty: "maybe",
				searchModes: "keyword",
				searchable: "name",
				select: [],
				selectable: "id",
				sort: null,
			}),
		).toEqual({})
		expect(parseQueryCatalog({ searchEmpty: "match-all" }).searchEmpty).toBe("match-all")
		expect(parseQueryCatalog({ filterable: [], sortable: [] })).toEqual({ filterable: [], sortable: [] })
	})
})
