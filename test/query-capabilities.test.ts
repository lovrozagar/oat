import { describe, expect, it } from "vitest"
import type { Client } from "../src/runtime/client.ts"
import { capabilitiesFromTag, resolveEntityCapabilities } from "../src/runtime/query-capabilities.ts"
import type { OperationModel, SpecModel } from "../src/spec/graph.ts"
import {
	anyFieldAllows,
	applyHarvest,
	applyHook,
	emptyCapabilities,
	fieldAllows,
	fieldAllowsNulls,
	inferFieldType,
	inferTypesFromSchema,
	isFieldType,
	isFilterOp,
	isNulls,
	mergeQueryCapabilities,
	ORDERED_TYPES,
	opsAreClosed,
	opsForField,
	parseFilterable,
	parseQueryCatalog,
	parseSortable,
	readJsonPathList,
	type EffectiveQueryCapabilities,
	type QueryCapabilities,
} from "../src/spec/query-capabilities.ts"
import {
	canWriteFilterOp,
	filterTerm,
	selectTerm,
	sortTerm,
	sortTermWithNulls,
	type QueryConventions,
} from "../src/spec/conventions.ts"
import { readQueryCapability } from "../src/spec/extensions.ts"
import type { Endpoint } from "../src/spec/types.ts"

const postgrest: QueryConventions = {
	envelope: {},
	filter: "filter",
	grammar: "postgrest",
	order: "order",
	search: "q",
	select: "select",
	selectGrammar: "csv",
	sortGrammar: "dotted",
}

function tagged(over: Partial<Parameters<typeof mergeQueryCapabilities>[0]["tag"]> = {}) {
	return mergeQueryCapabilities({
		tag: {
			filterable: ["id"],
			filterableDeclared: true,
			searchable: [],
			searchableDeclared: true,
			selectable: [],
			selectableDeclared: true,
			sortable: [],
			sortableDeclared: true,
			source: "tag",
			...over,
		},
	})
}

describe("query capability parse", () => {
	it("classifies tokens", () => {
		expect(isFilterOp("eq")).toBe(true)
		expect(isFilterOp("nope")).toBe(false)
		expect(isFieldType("string")).toBe(true)
		expect(isFieldType("blob")).toBe(false)
		expect(isNulls("first")).toBe(true)
		expect(isNulls("last")).toBe(true)
		expect(isNulls("middle")).toBe(false)
		expect(ORDERED_TYPES.has("number")).toBe(true)
		expect(ORDERED_TYPES.has("date")).toBe(true)
		expect(ORDERED_TYPES.has("string")).toBe(false)
	})

	it("parses filterable strings, structured rows, and junk", () => {
		expect(parseFilterable(undefined)).toEqual({ declared: false, fields: [] })
		expect(parseFilterable("id")).toEqual({ declared: true, fields: [] })
		expect(parseFilterable(["", 1, null, { field: "" }, { field: "id" }])).toEqual({
			declared: true,
			fields: [{ field: "id" }],
		})
		expect(
			parseFilterable([
				"name",
				{ field: "id", ops: ["eq", "bogus", 1], type: "nope" },
				{ field: "tags", ops: ["contains"], type: "array" },
				{ field: "empty", ops: [] },
			]),
		).toEqual({
			declared: true,
			fields: [
				{ field: "name" },
				{ field: "id", ops: ["eq"] },
				{ field: "tags", ops: ["contains"], type: "array" },
				{ field: "empty" },
			],
		})
	})

	it("parses sortable strings, structured rows, and junk", () => {
		expect(parseSortable(undefined)).toEqual({ declared: false, fields: [] })
		expect(parseSortable({})).toEqual({ declared: true, fields: [] })
		expect(parseSortable(["", null, { field: "" }, "name"])).toEqual({
			declared: true,
			fields: [{ field: "name" }],
		})
		expect(
			parseSortable([
				{ field: "created_at", nulls: ["first", "nope", 1], type: "date" },
				{ field: "empty", nulls: [] },
				{ field: "bogus", nulls: ["nope"] },
				{ field: "plain" },
			]),
		).toEqual({
			declared: true,
			fields: [
				{ field: "created_at", nulls: ["first"], type: "date" },
				{ field: "empty" },
				{ field: "bogus" },
				{ field: "plain" },
			],
		})
	})

	it("parses the full structured catalog and ignores invalid extras", () => {
		const catalog = parseQueryCatalog({
			aliases: { ne: "neq", nope: "eq", eq: 1 },
			emptyIn: "match-none",
			filterable: [{ field: "id", ops: ["eq"], type: "string" }],
			filterableFrom: {
				operationId: "table.get",
				path: "$.columns[*].name",
				typeMap: { text: "string", nope: "blob" },
				typePath: "$.columns[*].type",
			},
			identityFilter: "_id",
			maxFilterConditions: 20.8,
			maxInValues: 100,
			operators: ["eq", "in", "nope"],
			operatorsByType: { string: ["eq", "like"], nope: ["eq"], number: "eq" },
			searchCase: "insensitive",
			searchEmpty: "reject",
			searchModes: ["keyword", "", 1],
			searchable: ["name", 1],
			selectable: ["id", 1],
			selectableFrom: { path: "$.cols" },
			searchableFrom: { operationId: "GET /v1/meta", path: "$.s" },
			select: {
				nested: true,
				relations: [{ fields: ["id", 1], name: "owner" }, null, { fields: [], name: 1 }, { name: "x" }],
				unknown: "reject",
			},
			sortable: [{ field: "created_at", nulls: ["last"] }],
			sortableFrom: { path: "$.s", route: "GET /v1/meta" },
			sort: { defaultOrder: "created_at.desc", maxKeys: 3, nulls: ["first"], stableTiebreak: "id" },
		})
		expect(catalog.filterable?.[0]).toEqual({ field: "id", ops: ["eq"], type: "string" })
		expect(catalog.sortable?.[0]).toEqual({ field: "created_at", nulls: ["last"] })
		expect(catalog.searchable).toEqual(["name"])
		expect(catalog.selectable).toEqual(["id"])
		expect(catalog.operators).toEqual(["eq", "in"])
		expect(catalog.operatorsByType).toEqual({ string: ["eq", "like"] })
		expect(catalog.aliases).toEqual({ ne: "neq" })
		expect(catalog.identityFilter).toBe("_id")
		expect(catalog.emptyIn).toBe("match-none")
		expect(catalog.maxInValues).toBe(100)
		expect(catalog.maxFilterConditions).toBe(20)
		expect(catalog.searchModes).toEqual(["keyword"])
		expect(catalog.searchEmpty).toBe("reject")
		expect(catalog.searchCase).toBe("insensitive")
		expect(catalog.sort).toEqual({
			defaultOrder: "created_at.desc",
			maxKeys: 3,
			nulls: ["first"],
			stableTiebreak: "id",
		})
		expect(catalog.select).toEqual({
			nested: true,
			relations: [{ fields: ["id"], name: "owner" }],
			unknown: "reject",
		})
		expect(catalog.filterableFrom?.operationId).toBe("table.get")
		expect(catalog.filterableFrom?.typeMap).toEqual({ text: "string" })
		expect(catalog.searchableFrom?.route).toBe("GET /v1/meta")
		expect(catalog.sortableFrom?.route).toBe("GET /v1/meta")
	})

	it("accepts searchable: null and flat sort/select keys", () => {
		const catalog = parseQueryCatalog({
			defaultOrder: "name.asc",
			emptyIn: "reject",
			maxFilterConditions: 0,
			maxInValues: Number.NaN,
			searchCase: "sensitive",
			searchEmpty: "ignore",
			searchable: null,
			selectNested: false,
			selectUnknown: "ignore",
			sortNulls: ["last"],
			stableTiebreak: "id",
			maxSortKeys: 2,
		})
		expect(catalog.searchable).toBeNull()
		expect(catalog.emptyIn).toBe("reject")
		expect(catalog.maxInValues).toBeUndefined()
		expect(catalog.maxFilterConditions).toBeUndefined()
		expect(catalog.searchCase).toBe("sensitive")
		expect(catalog.searchEmpty).toBe("ignore")
		expect(catalog.sort).toEqual({
			defaultOrder: "name.asc",
			maxKeys: 2,
			nulls: ["last"],
			stableTiebreak: "id",
		})
		expect(catalog.select).toEqual({ nested: false, unknown: "ignore" })
	})

	it("drops empty sort/select blocks and invalid harvests", () => {
		expect(parseQueryCatalog({ defaultOrder: "", sort: null, select: [] })).toEqual({})
		expect(parseQueryCatalog({ filterableFrom: null }).filterableFrom).toBeUndefined()
		expect(parseQueryCatalog({ filterableFrom: [] }).filterableFrom).toBeUndefined()
		expect(parseQueryCatalog({ filterableFrom: { path: "" } }).filterableFrom).toBeUndefined()
		expect(parseQueryCatalog({ searchEmpty: "match-all" }).searchEmpty).toBe("match-all")
		expect(parseQueryCatalog({ sortNulls: ["nope"] }).sort).toBeUndefined()
		expect(parseQueryCatalog({ select: { nested: true, relations: [null, { name: 1 }] } }).select).toEqual({
			nested: true,
		})
		expect(parseQueryCatalog({ filterableFrom: { path: "$.x", operationId: "/v1/meta" } }).filterableFrom).toEqual({
			path: "$.x",
			route: "/v1/meta",
		})
		expect(parseQueryCatalog({ identityFilter: "" }).identityFilter).toBeUndefined()
		expect(parseQueryCatalog({ operatorsByType: null }).operatorsByType).toBeUndefined()
		expect(parseQueryCatalog({ aliases: [] }).aliases).toBeUndefined()
		expect(parseQueryCatalog({ searchEmpty: "maybe" }).searchEmpty).toBeUndefined()
	})
})

describe("query capability merge", () => {
	it("uses the tag only when config is absent — each axis", () => {
		const caps = mergeQueryCapabilities({
			tag: {
				filterFields: [{ field: "id", ops: ["eq", "in"], type: "string" }],
				filterable: ["id"],
				filterableDeclared: true,
				searchable: ["name"],
				searchableDeclared: true,
				selectable: ["id", "name"],
				selectableDeclared: true,
				sortable: ["created_at"],
				sortableDeclared: true,
				sortableFields: [{ field: "created_at", type: "date" }],
				source: "tag",
			},
		})
		expect(caps.source).toBe("tag")
		expect(caps.filterable.map((field) => field.field)).toEqual(["id"])
		expect(caps.filterable[0]?.ops).toEqual(["eq", "in"])
		expect(caps.sortable.map((field) => field.field)).toEqual(["created_at"])
		expect(caps.searchable).toEqual(["name"])
		expect(caps.selectable).toEqual(["id", "name"])
	})

	it("uses config only when the tag is heuristic — each axis", () => {
		const caps = mergeQueryCapabilities({
			entity: {
				filterable: [{ field: "_id", ops: ["eq", "neq"] }],
				searchable: ["_search"],
				selectable: ["_id"],
				sortable: [{ field: "_created_at", nulls: ["first", "last"] }],
			},
			tag: {
				filterable: ["id", "name"],
				searchable: ["name"],
				selectable: ["id"],
				sortable: ["name"],
				source: "heuristic",
			},
		})
		expect(caps.source).toBe("config")
		expect(caps.filterable.map((field) => field.field)).toEqual(["_id"])
		expect(caps.sortable.map((field) => field.field)).toEqual(["_created_at"])
		expect(caps.searchable).toEqual(["_search"])
		expect(caps.selectable).toEqual(["_id"])
	})

	it("unions tag + config fields on each axis and overlays the same name", () => {
		const caps = mergeQueryCapabilities({
			entity: {
				filterable: [
					{ field: "id", ops: ["in"], type: "string" },
					{ field: "slug", ops: ["eq"] },
				],
				searchable: ["slug"],
				selectable: ["slug"],
				sortable: [{ field: "name", nulls: ["last"] }, { field: "slug" }],
			},
			global: { searchable: ["name"], selectable: ["id"] },
			tag: {
				filterFields: [{ field: "id", ops: ["eq"] }],
				filterable: ["id"],
				filterableDeclared: true,
				searchable: ["name"],
				searchableDeclared: true,
				selectable: ["id"],
				selectableDeclared: true,
				sortable: ["name"],
				sortableDeclared: true,
				sortableFields: [{ field: "name" }],
				source: "tag",
			},
		})
		expect(caps.source).toBe("mixed")
		expect(caps.filterable).toEqual([
			{ field: "id", ops: ["in"], type: "string" },
			{ field: "slug", ops: ["eq"] },
		])
		expect(caps.sortable.find((field) => field.field === "name")?.nulls).toEqual(["last"])
		expect(caps.searchable).toEqual(["name", "slug"])
		expect(caps.selectable).toEqual(["id", "slug"])
	})

	it("treats an empty tagged list as a claim of none — does not infer scalars", () => {
		const caps = mergeQueryCapabilities({
			itemSchema: {
				properties: { id: { type: "string" }, name: { type: "string" } },
				type: "object",
			},
			tag: {
				filterable: [],
				filterableDeclared: true,
				searchable: [],
				searchableDeclared: true,
				selectable: [],
				selectableDeclared: true,
				sortable: [],
				sortableDeclared: true,
				source: "tag",
			},
		})
		expect(caps.filterable).toEqual([])
		expect(caps.sortable).toEqual([])
		expect(caps.searchable).toEqual([])
		expect(caps.selectable).toEqual([])
	})

	it("does not infer in / ilike / is / contains from today's string-array tag", () => {
		const caps = mergeQueryCapabilities({
			tag: {
				catalog: {},
				filterable: ["id"],
				filterableDeclared: true,
				searchable: [],
				searchableDeclared: false,
				selectable: [],
				selectableDeclared: false,
				sortable: ["created_at"],
				sortableDeclared: true,
				source: "tag",
			},
		})
		expect(caps.filterable[0]?.ops).toBeUndefined()
		expect(caps.operators).toBeUndefined()
		expect(opsForField(caps.filterable[0] ?? { field: "id" }, caps)).toEqual([
			"eq",
			"neq",
			"gt",
			"gte",
			"lt",
			"lte",
			"like",
		])
	})

	it("coalesces searchable null claims and global-only selectable", () => {
		expect(
			mergeQueryCapabilities({
				entity: { searchable: null },
				global: { searchable: ["name"], selectable: ["id"] },
				tag: null,
			}).searchable,
		).toEqual([])
		expect(
			mergeQueryCapabilities({
				entity: { searchable: ["a"] },
				global: { searchable: null },
				tag: null,
			}).searchable,
		).toEqual(["a"])
		expect(
			mergeQueryCapabilities({
				global: { searchable: null, selectable: ["id"] },
				tag: null,
			}).searchable,
		).toEqual([])
		expect(mergeQueryCapabilities({ global: { selectable: ["id"] }, tag: null }).selectable).toEqual(["id"])
	})

	it("lifts defaultOrder alone or stableTiebreak alone", () => {
		expect(
			mergeQueryCapabilities({
				tag: {
					defaultOrder: "name.asc",
					filterable: [],
					searchable: [],
					selectable: [],
					sortable: [],
					source: "tag",
				},
			}).sort,
		).toEqual({ defaultOrder: "name.asc" })
		expect(
			mergeQueryCapabilities({
				tag: {
					filterable: [],
					searchable: [],
					selectable: [],
					sortable: [],
					source: "tag",
					stableTiebreak: "id",
				},
			}).sort,
		).toEqual({ stableTiebreak: "id" })
	})

	it("lifts defaultOrder / stableTiebreak off the tag and overlays catalog extras", () => {
		const caps = mergeQueryCapabilities({
			entity: { emptyIn: "reject", identityFilter: "_id", maxInValues: 5 },
			global: {
				aliases: { ne: "neq" },
				maxFilterConditions: 10,
				operators: ["eq"],
				operatorsByType: { string: ["eq", "like"] },
				searchCase: "sensitive",
				searchEmpty: "ignore",
				searchModes: ["keyword"],
				select: { unknown: "ignore" },
				sort: { nulls: ["first"] },
				filterableFrom: { path: "$.a" },
				sortableFrom: { path: "$.b" },
				searchableFrom: { path: "$.c" },
				selectableFrom: { path: "$.d" },
			},
			tag: {
				catalog: { sort: { maxKeys: 2 } },
				defaultOrder: "created_at.desc",
				filterable: ["id"],
				searchable: [],
				selectable: [],
				sortable: [],
				source: "tag",
				stableTiebreak: "id",
			},
		})
		expect(caps.sort).toEqual({ defaultOrder: "created_at.desc", maxKeys: 2, nulls: ["first"], stableTiebreak: "id" })
		expect(caps.emptyIn).toBe("reject")
		expect(caps.identityFilter).toBe("_id")
		expect(caps.maxInValues).toBe(5)
		expect(caps.maxFilterConditions).toBe(10)
		expect(caps.operators).toEqual(["eq"])
		expect(caps.operatorsByType).toEqual({ string: ["eq", "like"] })
		expect(caps.aliases).toEqual({ ne: "neq" })
		expect(caps.searchCase).toBe("sensitive")
		expect(caps.searchEmpty).toBe("ignore")
		expect(caps.searchModes).toEqual(["keyword"])
		expect(caps.select).toEqual({ unknown: "ignore" })
		expect(caps.filterableFrom?.path).toBe("$.a")
		expect(caps.sortableFrom?.path).toBe("$.b")
		expect(caps.searchableFrom?.path).toBe("$.c")
		expect(caps.selectableFrom?.path).toBe("$.d")
	})

	it("infers field types from the item schema when the row omits them", () => {
		const caps = mergeQueryCapabilities({
			itemSchema: {
				properties: {
					amount: { type: "number" },
					flag: { type: "boolean" },
					id: { type: "string" },
					mystery: { type: "object" },
					skip: 1,
					when: { format: "date-time", type: "string" },
				},
				type: "object",
			},
			tag: {
				filterable: ["id", "amount", "when", "flag"],
				filterableDeclared: true,
				searchable: [],
				selectable: [],
				sortable: ["amount"],
				sortableDeclared: true,
				source: "tag",
			},
		})
		expect(caps.filterable.find((field) => field.field === "amount")?.type).toBe("number")
		expect(caps.filterable.find((field) => field.field === "when")?.type).toBe("date")
		expect(caps.sortable[0]?.type).toBe("number")
	})

	it("returns a heuristic empty map for a null tag", () => {
		expect(mergeQueryCapabilities({ tag: null }).source).toBe("heuristic")
		expect(emptyCapabilities()).toMatchObject({ filterable: [], hook: false, source: "heuristic" })
	})
})

describe("ops and nulls helpers", () => {
	it("resolves closed ops from the field, type table, then global list", () => {
		const base = tagged()
		const byField: EffectiveQueryCapabilities = {
			...base,
			filterable: [{ field: "id", ops: ["eq", "in"] }],
		}
		expect(opsForField({ field: "id", ops: ["eq"] }, byField)).toEqual(["eq"])
		expect(opsAreClosed({ field: "id", ops: ["eq"] }, byField)).toBe(true)

		const byType: EffectiveQueryCapabilities = {
			...base,
			filterable: [{ field: "name", type: "string" }],
			operatorsByType: { string: ["eq", "like"] },
		}
		expect(opsForField({ field: "name", type: "string" }, byType)).toEqual(["eq", "like"])
		expect(opsAreClosed({ field: "name", type: "string" }, byType)).toBe(true)

		const global: EffectiveQueryCapabilities = { ...base, operators: ["eq", "neq"] }
		expect(opsForField({ field: "id" }, global)).toEqual(["eq", "neq"])
		expect(opsAreClosed({ field: "id" }, global)).toBe(true)
		expect(opsAreClosed({ field: "id" }, base)).toBe(false)
		expect(
			opsForField({ field: "n", type: "number" }, { ...base, operators: ["in"], operatorsByType: { string: ["eq"] } }),
		).toEqual(["in"])
	})

	it("treats a declared alias as allowing the canonical op", () => {
		const caps: EffectiveQueryCapabilities = {
			...tagged(),
			aliases: { ne: "neq" },
			filterable: [{ field: "id", ops: ["eq", "ne"] }],
		}
		expect(fieldAllows({ field: "id", ops: ["eq", "ne"] }, "eq", caps)).toBe(true)
		expect(fieldAllows({ field: "id", ops: ["eq", "ne"] }, "neq", caps)).toBe(true)
		expect(fieldAllows({ field: "id", ops: ["eq", "ne"] }, "in", caps)).toBe(false)
		expect(
			fieldAllows({ field: "id", ops: ["eq"] }, "neq", {
				...caps,
				aliases: { ...caps.aliases, ...({ nope: "neq" } as object as typeof caps.aliases), gt: "gte" },
			}),
		).toBe(false)
		expect(fieldAllows({ field: "id", ops: ["eq"] }, "gte", { ...caps, aliases: { gt: "gte" } })).toBe(false)
		expect(fieldAllows({ field: "id", ops: ["ne"] }, "neq", { ...caps, aliases: { ne: "neq" } })).toBe(true)
		expect(anyFieldAllows(caps, "neq")?.field).toBe("id")
		expect(anyFieldAllows(caps, "contains")).toBeUndefined()
	})

	it("allows nulls from the field or the global sort default", () => {
		const caps: EffectiveQueryCapabilities = {
			...tagged(),
			sort: { nulls: ["last"] },
		}
		expect(fieldAllowsNulls({ field: "name", nulls: ["first"] }, caps, "first")).toBe(true)
		expect(fieldAllowsNulls({ field: "name" }, caps, "last")).toBe(true)
		expect(fieldAllowsNulls({ field: "name" }, caps, "first")).toBe(false)
	})
})

describe("harvest, hook, and JSONPath", () => {
	it("harvests each axis and maps types", () => {
		const caps = {
			...tagged(),
			filterableFrom: { path: "$.n", typeMap: { int: "number" as const } },
			sortableFrom: { path: "$.n", typeMap: { int: "number" as const } },
		}
		expect(applyHarvest(caps, ["", "alpha"], ["string"], "searchable").searchable).toEqual(["alpha"])
		expect(applyHarvest(caps, ["id"], [], "selectable").selectable).toEqual(["id"])
		const sorted = applyHarvest(caps, ["n"], ["int"], "sortable")
		expect(sorted.sortable).toEqual([{ field: "n", type: "number" }])
		const filtered = applyHarvest(caps, ["n"], ["int"], "filterable")
		expect(filtered.filterable.some((field) => field.field === "n" && field.type === "number")).toBe(true)
		expect(
			applyHarvest(caps, ["x"], ["nope"], "filterable").filterable.find((field) => field.field === "x")?.type,
		).toBe(undefined)
		expect(
			applyHarvest(caps, ["y"], ["string"], "filterable").filterable.find((field) => field.field === "y")?.type,
		).toBe("string")
		expect(applyHarvest(caps, ["z"]).filterable.some((field) => field.field === "z")).toBe(true)
	})

	it("lets the hook replace any axis, keep the merge, or swap only filterable", () => {
		const seeded = tagged()
		expect(applyHook(seeded, null).hook).toBe(true)
		expect(applyHook(seeded, null).filterable).toEqual(seeded.filterable)
		expect(applyHook(seeded, [{ field: "plain" }]).filterable).toEqual([{ field: "plain" }])
		expect(applyHook(seeded, [{ field: "dyn", ops: ["eq"], type: "string" }]).filterable).toEqual([
			{ field: "dyn", ops: ["eq"], type: "string" },
		])
		const replaced = applyHook(seeded, {
			aliases: { ne: "neq" },
			emptyIn: "reject",
			filterable: [{ field: "dyn", ops: ["in"] }],
			searchable: null,
			selectable: ["dyn"],
			sortable: [{ field: "plain" }, { field: "dyn", nulls: ["first"], type: "string" }],
		})
		expect(replaced.filterable).toEqual([{ field: "dyn", ops: ["in"] }])
		expect(replaced.sortable).toEqual([{ field: "plain" }, { field: "dyn", nulls: ["first"], type: "string" }])
		expect(replaced.searchable).toEqual([])
		expect(replaced.selectable).toEqual(["dyn"])
		expect(replaced.aliases).toEqual({ ne: "neq" })
		expect(replaced.emptyIn).toBe("reject")
		expect(applyHook({ ...seeded, source: "heuristic" }, {}).source).toBe("config")
		expect(applyHook({ ...seeded, source: "tag" }, {}).source).toBe("tag")
	})

	it("walks $, dots, indexes, wildcards, and filters", () => {
		const body = {
			columns: [
				{ name: "id", searchable: false, type: "text" },
				{ name: "title", searchable: true, type: "text" },
			],
			ok: { columns_json: [{ name: "a" }, { name: "b" }] },
		}
		expect(readJsonPathList(undefined, "$")).toEqual([])
		expect(readJsonPathList(body, "")).toEqual([body])
		expect(readJsonPathList(body, "$.ok.columns_json[*].name")).toEqual(["a", "b"])
		expect(readJsonPathList(body, "$.ok.columns_json[0].name")).toEqual(["a"])
		expect(readJsonPathList(body, "$.columns[?(@.searchable==true)].name")).toEqual(["title"])
		expect(readJsonPathList(body, "$.columns[?(@.searchable==false)].name")).toEqual(["id"])
		expect(readJsonPathList({ rows: [{ n: null }] }, "$.rows[?(@.n==null)].n")).toEqual([null])
		expect(readJsonPathList({ rows: [{ n: "x" }] }, '$.rows[?(@.n=="x")].n')).toEqual(["x"])
		expect(readJsonPathList({ rows: [{ n: "y" }] }, "$.rows[?(@.n=='y')].n")).toEqual(["y"])
		expect(readJsonPathList({ rows: [{ n: 2 }] }, "$.rows[?(@.n==2)].n")).toEqual([2])
		expect(readJsonPathList({ rows: [{ k: "z" }] }, "$.rows[?(@.k==z)].k")).toEqual(["z"])
		expect(readJsonPathList({ rows: [1, null, { name: "a" }] }, "$.rows[*].name")).toEqual(["a"])
		expect(readJsonPathList({ rows: [null, "x", { n: 1 }] }, "$.rows[?(@.n==1)]")).toEqual([{ n: 1 }])
		expect(readJsonPathList([{ name: "a" }], "$.name")).toEqual([])
		expect(readJsonPathList({ a: 1 }, "$.missing.x")).toEqual([])
		expect(readJsonPathList({ foo: { bar: 1 } }, "$.foo[bar]")).toEqual([1])
		expect(readJsonPathList({ raw: 1 }, "$.foo[unclosed")).toEqual([])
		expect(readJsonPathList([{ name: "a" }], "$[*].name")).toEqual(["a"])
		expect(readJsonPathList({ foo: { bar: 1 } }, "$.foo[*]")).toEqual([])
	})
})

describe("schema type inference", () => {
	it("reads enum, format, scalar, nullable-union, and unknown", () => {
		expect(inferFieldType(undefined)).toBeUndefined()
		expect(inferFieldType({ enum: ["a"] })).toBe("enum")
		expect(inferFieldType({ format: "date", type: "string" })).toBe("date")
		expect(inferFieldType({ format: "date-time", type: "string" })).toBe("date")
		expect(inferFieldType({ type: "array" })).toBe("array")
		expect(inferFieldType({ type: "boolean" })).toBe("boolean")
		expect(inferFieldType({ type: "integer" })).toBe("number")
		expect(inferFieldType({ type: "number" })).toBe("number")
		expect(inferFieldType({ type: "string" })).toBe("string")
		expect(inferFieldType({ type: ["string", "null"] })).toBe("string")
		expect(inferFieldType({ type: ["string", "number"] })).toBeUndefined()
		expect(inferFieldType({ type: "object" })).toBeUndefined()
		expect(inferTypesFromSchema(null).size).toBe(0)
		expect(inferTypesFromSchema({}).size).toBe(0)
		expect(inferTypesFromSchema({ properties: null }).size).toBe(0)
		expect(inferTypesFromSchema({ properties: { skip: 1, id: { type: "string" } } }).get("id")).toBe("string")
	})
})

describe("postgrest writers", () => {
	it("writes in / is / ilike / contains and dotted nulls", () => {
		expect(filterTerm(postgrest, "status", "in", ["a", "b"])).toEqual({ filter: "status.in.(a,b)" })
		expect(filterTerm(postgrest, "status", "in", "a")).toEqual({ filter: "status.in.(a)" })
		expect(filterTerm(postgrest, "status", "nin", [null, "b"])).toEqual({ filter: "status.nin.(null,b)" })
		expect(filterTerm(postgrest, "note", "is", "null")).toEqual({ filter: "note.is.null" })
		expect(filterTerm(postgrest, "note", "is", null)).toEqual({ filter: "note.is.null" })
		expect(filterTerm(postgrest, "note", "is", "notnull")).toEqual({ filter: "note.is.notnull" })
		expect(filterTerm(postgrest, "note", "is", "not.null")).toEqual({ filter: "note.is.notnull" })
		expect(filterTerm(postgrest, "note", "is", "true")).toBeNull()
		expect(filterTerm(postgrest, "name", "ilike", "FOO")).toEqual({ filter: "name.ilike.FOO" })
		expect(filterTerm(postgrest, "tags", "contains", "x")).toEqual({ filter: "tags.contains.x" })
		expect(filterTerm({ ...postgrest, filter: undefined }, "name", "eq", "x")).toBeNull()
		expect(filterTerm(postgrest, "name", "eq", ["a", "b"])).toBeNull()
		expect(sortTermWithNulls(postgrest, "name", "asc", "last")).toBe("name.asc.nullslast")
		expect(sortTerm(postgrest, "name", "asc", "first")).toBe("name.asc.nullsfirst")
		expect(sortTerm({ ...postgrest, sortGrammar: "colon" }, "name", "desc")).toBe("name:desc")
		expect(sortTerm({ ...postgrest, sortGrammar: "spaced" }, "name", "desc")).toBe("name desc")
		expect(sortTerm({ ...postgrest, sortGrammar: "prefixed" }, "name", "desc")).toBe("-name")
		expect(sortTerm({ ...postgrest, sortGrammar: "prefixed" }, "name", "asc")).toBe("name")
		expect(selectTerm(postgrest, ["id", "name"], "row")).toEqual({ select: "id,name" })
		expect(selectTerm({ ...postgrest, select: undefined }, ["id"], "row")).toBeNull()
		expect(selectTerm({ ...postgrest, select: "fields", selectGrammar: "bracketed" }, ["id"], "row")).toEqual({
			"fields[row]": "id",
		})
		expect(selectTerm({ ...postgrest, select: "fields[row]", selectGrammar: "bracketed" }, ["id"], "row")).toEqual({
			"fields[row]": "id",
		})
	})

	it("does not write in / ilike / is on colon or equality", () => {
		const colon: QueryConventions = { ...postgrest, grammar: "colon" }
		const equality: QueryConventions = { ...postgrest, filter: undefined, grammar: "equality" }
		expect(canWriteFilterOp(colon, "in")).toBe(false)
		expect(canWriteFilterOp(colon, "eq")).toBe(true)
		expect(canWriteFilterOp(equality, "eq")).toBe(true)
		expect(canWriteFilterOp(equality, "neq")).toBe(false)
		expect(filterTerm(colon, "status", "in", ["a", "b"])).toBeNull()
		expect(filterTerm(colon, "name", "ilike", "FOO")).toBeNull()
		expect(filterTerm({ ...colon, filter: undefined }, "name", "eq", "x")).toBeNull()
		expect(filterTerm(colon, "name", "eq", ["a"])).toBeNull()
		expect(filterTerm(colon, "name", "eq", "x")).toEqual({ filter: "name=eq:x" })
		expect(filterTerm(equality, "note", "is", "null")).toBeNull()
		expect(filterTerm(equality, "status", "eq", ["a"])).toBeNull()
		expect(filterTerm(equality, "status", "eq", "active")).toEqual({ status: "active" })
		expect(sortTermWithNulls({ ...postgrest, sortGrammar: "colon" }, "name", "asc", "last")).toBeNull()
	})
})

describe("x-query structured tag", () => {
	it("keeps declared empty lists and structured rows", () => {
		const endpoint = (tag: Record<string, unknown>): Endpoint =>
			({
				method: "get",
				op: { parameters: [], responses: {}, "x-query": tag },
				operationId: "row.list",
				path: "/rows",
			}) as Endpoint
		const taggedEmpty = readQueryCapability(
			endpoint({ filterable: [], searchable: null, selectable: [], sortable: [] }),
			{
				properties: { id: { type: "string" } },
				type: "object",
			},
		)
		expect(taggedEmpty?.filterableDeclared).toBe(true)
		expect(taggedEmpty?.searchableDeclared).toBe(true)
		expect(taggedEmpty?.filterable).toEqual([])
		expect(taggedEmpty?.searchable).toEqual([])
		const structured = readQueryCapability(
			endpoint({
				filterable: [{ field: "id", ops: ["eq", "in"] }],
				maxLimit: 50,
				defaultOrder: "id.asc",
				stableTiebreak: "id",
			}),
			null,
		)
		expect(structured?.filterFields?.[0]).toEqual({ field: "id", ops: ["eq", "in"] })
		expect(structured?.maxLimit).toBe(50)
		expect(structured?.defaultOrder).toBe("id.asc")
		expect(structured?.stableTiebreak).toBe("id")
	})
})

describe("live harvest and hook", () => {
	function modelWith(ops: Array<{ id: string; method: string; path: string }>): SpecModel {
		const byOperationId = new Map<string, OperationModel>()
		const byRoute = new Map<string, OperationModel>()
		for (const op of ops) {
			const row = { method: op.method, operationId: op.id, path: op.path } as OperationModel
			byOperationId.set(op.id, row)
			byRoute.set(`${op.method} ${op.path}`, row)
		}
		return { byOperationId, byRoute } as SpecModel
	}

	function clientWith(body: unknown): Client {
		return {
			request: async () => ({ responseBody: body }),
		} as unknown as Client
	}

	it("returns an empty map for a missing tag", () => {
		expect(capabilitiesFromTag(null)).toEqual(emptyCapabilities())
	})

	it("resolves without harvest when no *From is declared", async () => {
		const caps = await resolveEntityCapabilities({
			auth: () => ({}),
			client: clientWith({}),
			entityName: "row",
			hook: async () => null,
			model: modelWith([]),
			scope: {},
			tag: {
				filterable: ["id"],
				filterableDeclared: true,
				searchable: [],
				selectable: [],
				sortable: [],
				source: "tag",
			},
		})
		expect(caps.filterable.map((field) => field.field)).toEqual(["id"])
		expect(caps.hook).toBe(true)
		expect(caps.filterableFrom).toBeUndefined()
	})

	it("merges a tag through capabilitiesFromTag", () => {
		const caps = capabilitiesFromTag({
			filterable: ["id"],
			filterableDeclared: true,
			searchable: [],
			selectable: [],
			sortable: [],
			source: "tag",
		})
		expect(caps.source).toBe("tag")
		expect(caps.filterable.map((field) => field.field)).toEqual(["id"])
	})

	it("maps a typePath that mixes strings and junk", async () => {
		const caps = await resolveEntityCapabilities({
			auth: () => ({}),
			client: clientWith({ names: ["id", "n"], types: ["text", 1] }),
			entityName: "row",
			model: modelWith([{ id: "table.get", method: "GET", path: "/v1/tables/{id}" }]),
			scope: { id: "t1" },
			tag: {
				catalog: {
					filterableFrom: {
						operationId: "table.get",
						path: "$.names[*]",
						typeMap: { text: "string" },
						typePath: "$.types[*]",
					},
				},
				filterable: [],
				filterableDeclared: true,
				searchable: [],
				selectable: [],
				sortable: [],
				source: "tag",
			},
		})
		expect(caps.filterable).toEqual([{ field: "id", type: "string" }, { field: "n" }])
	})

	it("harvests every axis and then applies the hook", async () => {
		const body = {
			columns: [
				{ name: "id", searchable: false, type: "text" },
				{ name: "title", searchable: true, type: "text" },
			],
		}
		const caps = await resolveEntityCapabilities({
			auth: () => ({}),
			client: clientWith(body),
			entity: {
				filterableFrom: {
					operationId: "table.get",
					path: "$.columns[*].name",
					typeMap: { text: "string" },
					typePath: "$.columns[*].type",
				},
				searchableFrom: { operationId: "table.get", path: "$.columns[?(@.searchable==true)].name" },
				selectableFrom: { operationId: "table.get", path: "$.columns[*].name" },
				sortableFrom: { operationId: "table.get", path: "$.columns[*].name" },
			},
			entityName: "row",
			global: {},
			hook: async ({ get }) => {
				const harvested = await get("table.get")
				expect(harvested).toEqual(body)
				return { searchable: ["title"] }
			},
			itemSchema: { properties: { id: { type: "string" } }, type: "object" },
			model: modelWith([{ id: "table.get", method: "GET", path: "/v1/tables/{id}" }]),
			scope: { id: "t1" },
			tag: {
				filterable: ["id"],
				filterableDeclared: true,
				searchable: [],
				searchableDeclared: true,
				selectable: [],
				selectableDeclared: true,
				sortable: [],
				sortableDeclared: true,
				source: "tag",
			},
		})
		expect(caps.filterable.map((field) => field.field)).toEqual(["id", "title"])
		expect(caps.filterable.find((field) => field.field === "title")?.type).toBe("string")
		expect(caps.sortable.map((field) => field.field)).toEqual(["id", "title"])
		expect(caps.searchable).toEqual(["title"])
		expect(caps.selectable).toEqual(["id", "title"])
		expect(caps.hook).toBe(true)
	})

	it("resolves harvest by route and skips a harvest with no target", async () => {
		const caps = await resolveEntityCapabilities({
			auth: () => ({}),
			client: clientWith({ columns: [{ name: "n" }] }),
			entityName: "row",
			model: modelWith([{ id: "meta", method: "GET", path: "/v1/meta" }]),
			scope: {},
			tag: {
				catalog: {
					filterableFrom: { path: "$.columns[*].name" },
					sortableFrom: { operationId: "/v1/meta", path: "$.columns[*].name" },
				},
				filterable: [],
				filterableDeclared: true,
				searchable: [],
				selectable: [],
				sortable: [],
				sortableDeclared: true,
				source: "tag",
			},
		})
		expect(caps.filterable).toEqual([])
		expect(caps.sortable.map((field) => field.field)).toEqual(["n"])
	})

	it("throws when harvest names an unknown operation", async () => {
		await expect(
			resolveEntityCapabilities({
				auth: () => ({}),
				client: clientWith({}),
				entityName: "row",
				model: modelWith([]),
				scope: {},
				tag: {
					catalog: { filterableFrom: { operationId: "missing.get", path: "$.x" } },
					filterable: [],
					searchable: [],
					selectable: [],
					sortable: [],
					source: "tag",
				},
			}),
		).rejects.toThrow(/missing.get/)
		await expect(
			resolveEntityCapabilities({
				auth: () => ({}),
				client: clientWith({}),
				entityName: "row",
				model: modelWith([]),
				scope: {},
				tag: {
					catalog: { filterableFrom: { operationId: "NOT A ROUTE", path: "$.x" } },
					filterable: [],
					searchable: [],
					selectable: [],
					sortable: [],
					source: "tag",
				},
			}),
		).rejects.toThrow(/NOT A ROUTE/)
	})

	it("harvests without a typePath and accepts GET /path operation ids", async () => {
		const caps = await resolveEntityCapabilities({
			auth: () => ({}),
			client: clientWith({ names: ["a", 1] }),
			entityName: "row",
			model: modelWith([{ id: "meta", method: "GET", path: "/v1/meta" }]),
			scope: {},
			tag: {
				catalog: parseQueryCatalog({
					filterableFrom: { operationId: "GET /v1/meta", path: "$.names[*]" },
				}),
				filterable: [],
				filterableDeclared: true,
				searchable: [],
				selectable: [],
				sortable: [],
				source: "tag",
			},
		})
		expect(caps.filterable.map((field) => field.field)).toEqual(["a"])
	})
})
