import { describe, expect, it } from "vitest"
import type { Endpoint, JsonSchema, OperationObject } from "../types.ts"
import { GapCollector } from "./gaps.ts"
import { readQueryCapability } from "./query-tag.ts"

const listing = (op: Partial<OperationObject>, path = "/rows"): Endpoint => ({
	method: "get",
	op: { parameters: [], responses: {}, ...op } as OperationObject,
	operationId: "row.list",
	path,
})

const query = (name: string, schema: JsonSchema = { type: "string" }) => ({
	in: "query" as const,
	name,
	schema,
})

describe("x-query structured tag", () => {
	it("keeps declared empty lists and structured rows", () => {
		const taggedEmpty = readQueryCapability(
			listing({ "x-query": { filterable: [], searchable: null, selectable: [], sortable: [] } }),
			{ properties: { id: { type: "string" } }, type: "object" },
		)
		expect(taggedEmpty).toMatchObject({
			filterable: [],
			filterableDeclared: true,
			searchable: [],
			searchableDeclared: true,
			selectable: [],
			selectableDeclared: true,
			sortable: [],
			sortableDeclared: true,
			source: "tag",
		})
		const structured = readQueryCapability(
			listing({
				"x-query": {
					defaultOrder: "id.asc",
					filterable: [{ field: "id", ops: ["eq", "in"] }],
					maxLimit: 50,
					searchable: ["name"],
					selectable: ["id"],
					sortable: ["name"],
					stableTiebreak: "id",
				},
			}),
			null,
		)
		expect(structured?.filterFields?.[0]).toEqual({ field: "id", ops: ["eq", "in"] })
		expect(structured).toMatchObject({
			defaultOrder: "id.asc",
			filterable: ["id"],
			maxLimit: 50,
			searchable: ["name"],
			selectable: ["id"],
			sortable: ["name"],
			sortableFields: [{ field: "name" }],
			stableTiebreak: "id",
		})
	})

	it("reads a tag without lists as declaring none of them", () => {
		const bare = readQueryCapability(listing({ "x-query": { maxLimit: "50", searchable: "name" } }), null)
		expect(bare).toMatchObject({
			filterable: [],
			filterableDeclared: false,
			searchable: [],
			searchableDeclared: true,
			selectable: [],
			selectableDeclared: false,
			sortable: [],
			sortableDeclared: false,
		})
		expect(bare?.maxLimit).toBeUndefined()
		expect(bare?.defaultOrder).toBeUndefined()
	})
})

/*
 * Without `x-query`, oat guesses which fields a listing sorts by. A parameter of the list's own
 * path — the project every listed record sits under — holds one value across the listing, so
 * ordering by it shows nothing; it is never guessed sortable. It stays filterable.
 */
const item = {
	properties: {
		blob: { type: "object" },
		id: { type: "string" },
		name: { type: "string" },
		nick: { oneOf: [{ type: "string" }, { type: "null" }] },
		note: { anyOf: [{ type: "string" }, null] },
		project_id: { type: ["string", "null"] },
		raw: null,
		tags: { type: ["array", "null"] },
		untyped: {},
	},
	type: "object",
}

describe("a guessed capability", () => {
	it("never sorts by a parameter of the list's own path", () => {
		const gaps = new GapCollector()
		const capability = readQueryCapability(
			listing(
				{
					parameters: [
						{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
						query("order"),
						query("filter"),
					],
				},
				"/v1/projects/{project_id}/tables",
			),
			item,
			gaps,
		)
		expect(capability).toEqual({
			filterable: ["id", "name", "nick", "project_id"],
			searchable: ["name"],
			selectable: ["id", "name", "nick", "project_id"],
			sortable: ["id", "name", "nick"],
			source: "heuristic",
		})
		expect(gaps.gaps).toEqual([
			{
				detail:
					"endpoint accepts filter/order but does not declare which fields support them. Assuming all 4 scalar " +
					"properties, which will produce false failures on unindexed fields",
				operationId: "row.list",
				tag: "x-query",
			},
		])
	})

	it("takes the page size's documented maximum", () => {
		const capped = readQueryCapability(
			listing({ parameters: [query("select"), query("limit", { maximum: 100, type: "integer" })] }),
			null,
		)
		expect(capped).toMatchObject({ filterable: [], maxLimit: 100 })
		const open = readQueryCapability(listing({ parameters: [query("q"), query("limit", { type: "integer" })] }), null)
		expect(open?.maxLimit).toBeUndefined()
	})

	it("reads an item without properties as no scalars", () => {
		expect(readQueryCapability(listing({ parameters: [query("filter")] }), { properties: null })?.filterable).toEqual(
			[],
		)
	})

	it("is null for a list that takes no query grammar", () => {
		expect(readQueryCapability(listing({ parameters: [query("page"), query("limit")] }), null)).toBeNull()
		expect(readQueryCapability({ ...listing({}), op: { responses: {} } }, null)).toBeNull()
	})
})

describe("a guessed capability's scalar fields", () => {
	it("counts the nullable, untyped and wrapped scalars, and nothing that is only null or empty", () => {
		const record = {
			properties: {
				both: { type: ["string", "integer"] },
				code: { enum: ["a", "b"] },
				empty: { type: [] },
				legacy: { nullable: true, type: "string" },
				nobody: { oneOf: [{ type: "null" }] },
				note: { oneOf: [{ type: "string" }, { type: "null" }] },
				titled: { allOf: [{ type: "string" }, { description: "a title" }] },
			},
			type: "object",
		}
		const capability = readQueryCapability(listing({ parameters: [query("filter")] }), record)
		expect(capability?.filterable).toEqual(["both", "code", "legacy", "note", "titled"])
	})
})
