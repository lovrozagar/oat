import { describe, expect, it } from "vitest"
import type { MergeTag } from "./effective.ts"
import { assignOptional, overlayCatalog } from "./catalog-layers.ts"
import { emptyCapabilities } from "./merge.ts"

const tag = (over: Partial<MergeTag>): MergeTag => ({
	filterable: [],
	searchable: [],
	selectable: [],
	sortable: [],
	source: "tag",
	...over,
})

describe("catalog layers", () => {
	it("stacks tag, global and entity: a later layer replaces a key, tables merge", () => {
		const out = overlayCatalog(
			tag({ catalog: { aliases: { ne: "neq" }, emptyIn: "reject", operators: ["eq"], sort: { maxKeys: 2 } } }),
			{ aliases: { gt: "gte" }, operators: ["in"], operatorsByType: { string: ["eq"] }, select: { nested: true } },
			{
				emptyIn: "match-none",
				operatorsByType: { number: ["gt"] },
				select: { unknown: "ignore" },
				sort: { nulls: ["first"] },
			},
		)
		expect(out).toEqual({
			aliases: { gt: "gte", ne: "neq" },
			emptyIn: "match-none",
			operators: ["in"],
			operatorsByType: { number: ["gt"], string: ["eq"] },
			select: { nested: true, unknown: "ignore" },
			sort: { maxKeys: 2, nulls: ["first"] },
		})
		expect(Object.keys(out)).toEqual(["operators", "aliases", "emptyIn", "sort", "operatorsByType", "select"])
	})

	it("lifts the tag's flat defaultOrder and stableTiebreak into its catalog's sort, in place", () => {
		const catalog = { sort: { maxKeys: 2 } }
		const out = overlayCatalog(tag({ catalog, defaultOrder: "a.asc", stableTiebreak: "id" }), undefined, undefined)
		expect(out.sort).toEqual({ defaultOrder: "a.asc", maxKeys: 2, stableTiebreak: "id" })
		expect(catalog.sort).toEqual(out.sort)
		expect(overlayCatalog(tag({ defaultOrder: "a.asc" }), undefined, undefined).sort).toEqual({ defaultOrder: "a.asc" })
		expect(overlayCatalog(tag({ stableTiebreak: "id" }), undefined, undefined).sort).toEqual({ stableTiebreak: "id" })
		expect(overlayCatalog(null, undefined, undefined)).toEqual({})
	})
})

describe("catalog layers: carried keys", () => {
	it("carries every optional key but aliases onto the effective map", () => {
		const target = emptyCapabilities()
		assignOptional(target, {
			aliases: { ne: "neq" },
			emptyIn: "reject",
			filterableFrom: { path: "$.a" },
			identityFilter: "_id",
			limitOutOfRange: "clamp",
			maxFilterConditions: 4,
			maxInValues: 5,
			operators: ["eq"],
			operatorsByType: { string: ["eq"] },
			searchCase: "sensitive",
			searchEmpty: "ignore",
			searchModes: ["keyword"],
			searchableFrom: { path: "$.c" },
			select: { nested: true },
			selectableFrom: { path: "$.d" },
			sort: { maxKeys: 1 },
			sortableFrom: { path: "$.b" },
		})
		expect(target.aliases).toEqual({})
		expect(Object.keys(target).slice(7)).toEqual([
			"operators",
			"operatorsByType",
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
		])
	})
})
