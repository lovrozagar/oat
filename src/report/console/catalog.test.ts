import { describe, expect, it } from "vitest"
import { documentOf, listOp, modelOf, referenceModel } from "./__fixtures__/models.ts"
import { entityQueryCatalogs } from "./catalog.ts"

describe("entityQueryCatalogs from the document", () => {
	it("catalogs each listable entity by name, from the document alone", async () => {
		const { model } = await referenceModel()
		const { catalogs, unknownEntities } = entityQueryCatalogs(model)
		expect(catalogs.map((row) => row.entity)).toEqual(["job", "notice", "row", "table"])
		expect(unknownEntities).toEqual([])
		const table = catalogs.find((row) => row.entity === "table")
		expect(table).toMatchObject({ hook: false, maxFilterConditions: 20, maxInValues: 100, source: "tag" })
		expect(table?.harvest).toEqual([])
		expect(table?.grammar).toBeUndefined()
		expect(table?.checks).toContain("filter.in-is-union-of-eq")
		const notice = catalogs.find((row) => row.entity === "notice")
		expect(Object.keys(notice ?? {})).toEqual([
			"aliases",
			"checks",
			"entity",
			"filterable",
			"harvest",
			"hook",
			"searchable",
			"selectable",
			"sortable",
			"source",
		])
	})

	it("describes the templates a list declares", async () => {
		const { catalogs } = entityQueryCatalogs((await referenceModel({ dialect: "template" })).model)
		const table = catalogs.find((row) => row.entity === "table")
		expect(table?.grammar).toMatch(/^template /)
		expect(table?.sortGrammar).toMatch(/^template /)
	})
})

describe("entityQueryCatalogs with config", () => {
	it("lays config over the document, names config entities the document lacks, and notes a hook", async () => {
		const { model } = await referenceModel({ untagged: true })
		const from = { path: "$.fields" }
		const { catalogs, unknownEntities } = entityQueryCatalogs(model, {
			entities: { ghost: {}, row: {}, table: { query: { searchable: ["name"], selectableFrom: from } } },
			hooks: { resolveQueryCapabilities: async () => null },
			query: {
				emptyIn: "reject",
				filterable: [{ field: "name", ops: ["eq", "in"] }],
				filterableFrom: from,
				identityFilter: "id",
				maxFilterConditions: 4,
				maxInValues: 9,
				operators: ["eq", "in"],
				operatorsByType: { string: ["eq"] },
				searchEmpty: "ignore",
				searchModes: ["plain"],
				searchableFrom: from,
				select: { unknown: "ignore" },
				sort: { maxKeys: 2 },
				sortableFrom: from,
			},
		})
		expect(unknownEntities).toEqual(["ghost"])
		const table = catalogs.find((row) => row.entity === "table")
		expect(table).toMatchObject({
			emptyIn: "reject",
			hook: true,
			identityFilter: "id",
			maxFilterConditions: 4,
			maxInValues: 9,
			operators: ["eq", "in"],
			operatorsByType: { string: ["eq"] },
			searchEmpty: "ignore",
			searchModes: ["plain"],
			searchable: ["name"],
			select: { unknown: "ignore" },
			sort: { maxKeys: 2 },
		})
		expect(table?.harvest).toEqual(["filterableFrom", "sortableFrom", "searchableFrom", "selectableFrom"])
	})

	it("catalogs a list whose answer has no rows to read types from", () => {
		const list = { ...(listOp("note", "notes.list") as object), responses: { "200": { description: "ok" } } }
		const { catalogs } = entityQueryCatalogs(modelOf(documentOf({ "/notes": { get: list } })).model)
		expect(catalogs.map((row) => [row.entity, row.source])).toEqual([["note", "heuristic"]])
	})
})
