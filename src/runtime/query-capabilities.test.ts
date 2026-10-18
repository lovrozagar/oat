import { describe, expect, it } from "vitest"
import type { Client } from "../client/client.ts"
import { capabilitiesFromTag, resolveEntityCapabilities } from "./query-capabilities.ts"
import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import { emptyCapabilities } from "../spec/query/merge.ts"
import { parseQueryCatalog } from "../spec/query/parse-catalog.ts"
import { canWriteFilterOp, filterTerm } from "../spec/conventions/filter.ts"
import { selectTerm } from "../spec/conventions/select.ts"
import { sortTerm, sortTermWithNulls } from "../spec/conventions/sort.ts"
import type { QueryConventions } from "../spec/conventions/types.ts"

/* The conventions with one parameter role absent, as a document without that parameter derives them. */
function without(conventions: QueryConventions, role: "filter" | "select"): QueryConventions {
	const copy = { ...conventions }
	delete copy[role]
	return copy
}

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
		expect(filterTerm(without(postgrest, "filter"), "name", "eq", "x")).toBeNull()
		expect(filterTerm(postgrest, "name", "eq", ["a", "b"])).toBeNull()
		expect(sortTermWithNulls(postgrest, "name", "asc", "last")).toBe("name.asc.nullslast")
		expect(sortTerm(postgrest, "name", "asc", "first")).toBe("name.asc.nullsfirst")
		expect(sortTerm({ ...postgrest, sortGrammar: "colon" }, "name", "desc")).toBe("name:desc")
		expect(sortTerm({ ...postgrest, sortGrammar: "spaced" }, "name", "desc")).toBe("name desc")
		expect(sortTerm({ ...postgrest, sortGrammar: "prefixed" }, "name", "desc")).toBe("-name")
		expect(sortTerm({ ...postgrest, sortGrammar: "prefixed" }, "name", "asc")).toBe("name")
		expect(selectTerm(postgrest, ["id", "name"], "row")).toEqual({ select: "id,name" })
		expect(selectTerm(without(postgrest, "select"), ["id"], "row")).toBeNull()
		expect(selectTerm({ ...postgrest, select: "fields", selectGrammar: "bracketed" }, ["id"], "row")).toEqual({
			"fields[row]": "id",
		})
		expect(selectTerm({ ...postgrest, select: "fields[row]", selectGrammar: "bracketed" }, ["id"], "row")).toEqual({
			"fields[row]": "id",
		})
	})

	it("does not write in / ilike / is on colon or equality", () => {
		const colon: QueryConventions = { ...postgrest, grammar: "colon" }
		const equality: QueryConventions = { ...without(postgrest, "filter"), grammar: "equality" }
		expect(canWriteFilterOp(colon, "in")).toBe(false)
		expect(canWriteFilterOp(colon, "eq")).toBe(true)
		expect(canWriteFilterOp(equality, "eq")).toBe(true)
		expect(canWriteFilterOp(equality, "neq")).toBe(false)
		expect(filterTerm(colon, "status", "in", ["a", "b"])).toBeNull()
		expect(filterTerm(colon, "name", "ilike", "FOO")).toBeNull()
		expect(filterTerm(without(colon, "filter"), "name", "eq", "x")).toBeNull()
		expect(filterTerm(colon, "name", "eq", ["a"])).toBeNull()
		expect(filterTerm(colon, "name", "eq", "x")).toEqual({ filter: "name=eq:x" })
		expect(filterTerm(equality, "note", "is", "null")).toBeNull()
		expect(filterTerm(equality, "status", "eq", ["a"])).toBeNull()
		expect(filterTerm(equality, "status", "eq", "active")).toEqual({ status: "active" })
		expect(sortTermWithNulls({ ...postgrest, sortGrammar: "colon" }, "name", "asc", "last")).toBeNull()
	})
})

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

describe("live harvest and hook", () => {
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
})

describe("live harvest of type paths", () => {
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
})

describe("live harvest across every axis", () => {
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
})

describe("live harvest by route", () => {
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
})

describe("live harvest failures and route ids", () => {
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
