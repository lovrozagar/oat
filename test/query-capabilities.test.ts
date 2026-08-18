import { describe, expect, it } from "vitest"
import { applyHook, applyHarvest, mergeQueryCapabilities } from "../src/spec/query-capabilities.ts"
import { filterTerm, sortTermWithNulls, type QueryConventions } from "../src/spec/conventions.ts"

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

	it("unions tag + config fields on each axis", () => {
		const caps = mergeQueryCapabilities({
			entity: {
				filterable: [{ field: "slug", ops: ["eq"] }],
				searchable: ["slug"],
				selectable: ["slug"],
				sortable: [{ field: "slug" }],
			},
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
		expect(caps.filterable.map((field) => field.field)).toEqual(["id", "slug"])
		expect(caps.sortable.map((field) => field.field)).toEqual(["name", "slug"])
		expect(caps.searchable).toEqual(["name", "slug"])
		expect(caps.selectable).toEqual(["id", "slug"])
	})

	it("lets the hook replace any axis", () => {
		const seeded = mergeQueryCapabilities({
			tag: {
				filterable: ["id"],
				filterableDeclared: true,
				searchable: ["name"],
				searchableDeclared: true,
				selectable: ["id"],
				selectableDeclared: true,
				sortable: ["name"],
				sortableDeclared: true,
				source: "tag",
			},
		})
		const replaced = applyHook(seeded, {
			filterable: [{ field: "dyn", ops: ["eq", "in"], type: "string" }],
			searchable: ["dyn"],
			selectable: ["dyn"],
			sortable: [{ field: "dyn", type: "string" }],
		})
		expect(replaced.hook).toBe(true)
		expect(replaced.filterable).toEqual([{ field: "dyn", ops: ["eq", "in"], type: "string" }])
		expect(replaced.sortable).toEqual([{ field: "dyn", type: "string" }])
		expect(replaced.searchable).toEqual(["dyn"])
		expect(replaced.selectable).toEqual(["dyn"])
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
		expect(caps.sort?.nulls).toBeUndefined()
		expect(caps.searchModes).toBeUndefined()
		expect(caps.select?.unknown).toBeUndefined()
		expect(caps.emptyIn).toBeUndefined()
		const implicit = ["eq", "neq", "gt", "gte", "lt", "lte", "like"]
		expect(caps.filterable.every((field) => field.ops === undefined)).toBe(true)
		void implicit
	})

	it("harvests a named axis onto the merge", () => {
		const caps = mergeQueryCapabilities({
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
		const harvested = applyHarvest(caps, ["alpha", "beta"], ["string", "number"], "filterable")
		expect(harvested.filterable.map((field) => field.field)).toEqual(["id", "alpha", "beta"])
		expect(harvested.filterable[2]?.type).toBe("number")
	})
})

describe("postgrest writers", () => {
	it("writes in / is / ilike / contains and dotted nulls", () => {
		expect(filterTerm(postgrest, "status", "in", ["a", "b"])).toEqual({ filter: "status.in.(a,b)" })
		expect(filterTerm(postgrest, "note", "is", "null")).toEqual({ filter: "note.is.null" })
		expect(filterTerm(postgrest, "name", "ilike", "FOO")).toEqual({ filter: "name.ilike.FOO" })
		expect(filterTerm(postgrest, "tags", "contains", "x")).toEqual({ filter: "tags.contains.x" })
		expect(sortTermWithNulls(postgrest, "name", "asc", "last")).toBe("name.asc.nullslast")
	})

	it("does not write in / ilike / is on colon or equality", () => {
		const colon: QueryConventions = { ...postgrest, grammar: "colon" }
		const equality: QueryConventions = { ...postgrest, filter: undefined, grammar: "equality" }
		expect(filterTerm(colon, "status", "in", ["a", "b"])).toBeNull()
		expect(filterTerm(colon, "name", "ilike", "FOO")).toBeNull()
		expect(filterTerm(equality, "note", "is", "null")).toBeNull()
		expect(sortTermWithNulls({ ...postgrest, sortGrammar: "colon" }, "name", "asc", "last")).toBeNull()
	})
})
