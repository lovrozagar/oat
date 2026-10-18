import { describe, expect, it } from "vitest"
import { opsForField } from "./field-ops.ts"
import { emptyCapabilities, mergeQueryCapabilities } from "./merge.ts"

/* The searchable names the merge gives for an entity and a global config. */
const searchable = (entity: string[] | null | undefined, global: string[] | null | undefined) =>
	mergeQueryCapabilities({
		...(entity === undefined ? {} : { entity: { searchable: entity } }),
		...(global === undefined ? {} : { global: { searchable: global } }),
		tag: null,
	}).searchable

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
		expect(caps.filterable).toEqual([{ field: "id", ops: ["eq", "in"], type: "string" }])
		expect(caps.sortable).toEqual([{ field: "created_at", type: "date" }])
		expect(caps.searchable).toEqual(["name"])
		expect(caps.selectable).toEqual(["id", "name"])
	})

	it("reads the tag's names as rows when it gave no structured ones", () => {
		const caps = mergeQueryCapabilities({
			tag: {
				filterable: ["id"],
				filterableDeclared: true,
				searchable: [],
				selectable: [],
				sortable: ["name"],
				sortableDeclared: true,
				source: "tag",
			},
		})
		expect(caps.filterable).toEqual([{ field: "id" }])
		expect(caps.sortable).toEqual([{ field: "name" }])
	})
})

describe("merge: config, or the guess", () => {
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
				filterableDeclared: true,
				searchable: ["name"],
				selectable: ["id"],
				sortable: ["name"],
				source: "heuristic",
			},
		})
		expect(caps.source).toBe("config")
		expect(caps.filterable.map((field) => field.field)).toEqual(["_id"])
		expect(caps.sortable).toEqual([{ field: "_created_at", nulls: ["first", "last"] }])
		expect(caps.searchable).toEqual(["_search"])
		expect(caps.selectable).toEqual(["_id"])
	})

	it("falls back to the heuristic tag when nobody declared an axis", () => {
		const caps = mergeQueryCapabilities({
			tag: { filterable: ["id"], searchable: ["name"], selectable: ["id"], sortable: ["name"], source: "heuristic" },
		})
		expect(caps.source).toBe("heuristic")
		expect(caps.filterable).toEqual([{ field: "id" }])
		expect(caps.sortable).toEqual([{ field: "name" }])
		expect(caps.searchable).toEqual(["name"])
		expect(caps.selectable).toEqual(["id"])
	})
})

describe("merge: tag and config together", () => {
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
			global: { filterable: [{ field: "g" }], searchable: ["name"], selectable: ["id"], sortable: [{ field: "g" }] },
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
			{ field: "g" },
			{ field: "slug", ops: ["eq"] },
		])
		expect(caps.sortable).toEqual([{ field: "name", nulls: ["last"] }, { field: "g" }, { field: "slug" }])
		expect(caps.searchable).toEqual(["name", "slug"])
		expect(caps.selectable).toEqual(["id", "slug"])
	})
})

describe("merge: a declared none", () => {
	it("treats an empty tagged list as a claim of none — does not infer scalars", () => {
		const caps = mergeQueryCapabilities({
			itemSchema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
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
		expect(opsForField({ field: "id" }, caps)).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "like"])
	})
})

describe("merge: config searchable and selectable", () => {
	it("coalesces searchable null claims and global-only selectable", () => {
		expect(searchable(null, ["name"])).toEqual([])
		expect(searchable(["a"], null)).toEqual(["a"])
		expect(searchable(["a"], undefined)).toEqual(["a"])
		expect(searchable(["a"], ["b", "a"])).toEqual(["b", "a"])
		expect(searchable(undefined, null)).toEqual([])
		expect(searchable(undefined, ["b"])).toEqual(["b"])
		expect(mergeQueryCapabilities({ entity: {}, global: { selectable: ["id"] }, tag: null }).searchable).toEqual([])
		expect(mergeQueryCapabilities({ global: { selectable: ["id"] }, tag: null }).selectable).toEqual(["id"])
		expect(mergeQueryCapabilities({ entity: { selectable: ["x"] }, tag: null }).selectable).toEqual(["x"])
	})
})

describe("merge: catalog extras", () => {
	it("lifts defaultOrder / stableTiebreak off the tag and overlays catalog extras", () => {
		const caps = mergeQueryCapabilities({
			entity: { emptyIn: "reject", identityFilter: "_id", maxInValues: 5 },
			global: {
				aliases: { ne: "neq" },
				filterableFrom: { path: "$.a" },
				maxFilterConditions: 10,
				operators: ["eq"],
				operatorsByType: { string: ["eq", "like"] },
				searchCase: "sensitive",
				searchEmpty: "ignore",
				searchModes: ["keyword"],
				searchableFrom: { path: "$.c" },
				select: { unknown: "ignore" },
				selectableFrom: { path: "$.d" },
				sort: { nulls: ["first"] },
				sortableFrom: { path: "$.b" },
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
})

describe("merge: inferred types and the empty map", () => {
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
				filterFields: [{ field: "id", type: "enum" }, { field: "amount" }, { field: "when" }, { field: "mystery" }],
				filterable: ["id", "amount", "when", "mystery"],
				filterableDeclared: true,
				searchable: [],
				selectable: [],
				sortable: ["amount", "mystery"],
				sortableDeclared: true,
				sortableFields: [{ field: "amount" }, { field: "mystery", type: "string" }],
				source: "tag",
			},
		})
		expect(caps.filterable).toEqual([
			{ field: "id", type: "enum" },
			{ field: "amount", type: "number" },
			{ field: "when", type: "date" },
			{ field: "mystery" },
		])
		expect(caps.sortable).toEqual([
			{ field: "amount", type: "number" },
			{ field: "mystery", type: "string" },
		])
	})

	it("returns a heuristic empty map for a null tag", () => {
		expect(mergeQueryCapabilities({ tag: null })).toEqual(emptyCapabilities())
		expect(emptyCapabilities()).toEqual({
			aliases: {},
			filterable: [],
			hook: false,
			searchable: [],
			selectable: [],
			sortable: [],
			source: "heuristic",
		})
	})
})
