import { describe, expect, it } from "vitest"
import type { QueryConventions } from "../conventions/types.ts"
import type { QueryCapability } from "../extensions/query-tag.ts"
import type { EffectiveQueryCapabilities } from "./effective.ts"
import { emptyCapabilities } from "./merge.ts"
import { describeWithheld, filterIsGuess, queryOver, restoreWithheld, sendableCapabilities } from "./sendable.ts"

/*
 * A query probe reaches the backend only through a parameter the list operation declares, or one
 * the config states for the entity. Whatever no parameter can carry is withheld, with the reason.
 */

const EQUALITY: QueryConventions = { envelope: {}, grammar: "equality", selectGrammar: "csv", sortGrammar: "dotted" }
const POSTGREST: QueryConventions = { ...EQUALITY, filter: "filter", grammar: "postgrest" }

const caps = (extra: Partial<EffectiveQueryCapabilities> = {}): EffectiveQueryCapabilities => ({
	...emptyCapabilities(),
	filterable: [{ field: "id" }, { field: "enabled", type: "boolean" }],
	searchable: ["username"],
	selectable: ["id"],
	sortable: [{ field: "username" }],
	...extra,
})

describe("sendableCapabilities", () => {
	it("withholds a guessed per-field filter whose parameter the list does not declare", () => {
		const { capabilities, withheld } = sendableCapabilities(
			caps(),
			{ conventions: EQUALITY, queryParamNames: ["enabled"] },
			true,
		)
		expect(capabilities.filterable).toEqual([{ field: "enabled", type: "boolean" }])
		expect(withheld).toContainEqual({ axis: "filterable", row: { field: "id" } })
	})

	it("keeps a per-field filter the document or config stated, parameter or not", () => {
		const { capabilities } = sendableCapabilities(caps(), { conventions: EQUALITY, queryParamNames: [] }, false)
		expect(capabilities.filterable.map((field) => field.field)).toEqual(["id", "enabled"])
	})

	it("keeps every guessed field a filter expression parameter carries", () => {
		const { capabilities } = sendableCapabilities(
			caps(),
			{ conventions: { ...POSTGREST, order: "sort", search: "q", select: "fields" }, queryParamNames: ["filter"] },
			true,
		)
		expect(capabilities.filterable.map((field) => field.field)).toEqual(["id", "enabled"])
		expect(capabilities.sortable).toEqual([{ field: "username" }])
		expect(capabilities.searchable).toEqual(["username"])
		expect(capabilities.selectable).toEqual(["id"])
	})

	it("withholds sort, search and select when the list declares no parameter for them", () => {
		const { capabilities, withheld } = sendableCapabilities(
			caps(),
			{ conventions: POSTGREST, queryParamNames: ["filter"] },
			false,
		)
		expect([capabilities.sortable, capabilities.searchable, capabilities.selectable]).toEqual([[], [], []])
		expect(withheld).toEqual([
			{ axis: "sortable", row: { field: "username" } },
			{ axis: "searchable", row: "username" },
			{ axis: "selectable", row: "id" },
		])
	})
})

describe("restoreWithheld", () => {
	it("puts the withheld rows back on their axes", () => {
		const { capabilities, withheld } = sendableCapabilities(
			caps(),
			{ conventions: EQUALITY, queryParamNames: [] },
			true,
		)
		const restored = restoreWithheld(capabilities, withheld)
		expect(restored.filterable.map((field) => field.field)).toEqual(["id", "enabled"])
		expect(restored.sortable).toEqual([{ field: "username" }])
		expect(restored.searchable).toEqual(["username"])
		expect(restored.selectable).toEqual(["id"])
	})
})

describe("describeWithheld", () => {
	it("names the parameter each axis is missing", () => {
		expect(describeWithheld([{ axis: "filterable", row: { field: "id" } }])).toBe(
			"the `id` query parameter, which the list operation does not declare",
		)
		expect(
			describeWithheld([
				{ axis: "filterable", row: { field: "id" } },
				{ axis: "filterable", row: { field: "name" } },
				{ axis: "sortable", row: { field: "name" } },
				{ axis: "sortable", row: { field: "id" } },
				{ axis: "searchable", row: "name" },
				{ axis: "selectable", row: "id" },
			]),
		).toBe(
			"the `id`, `name` query parameters, which the list operation does not declare; " +
				"a sort parameter, which the list operation does not declare; " +
				"a free-text search parameter, which the list operation does not declare; " +
				"a sparse-fieldset parameter, which the list operation does not declare",
		)
	})

	it("names the first few missing filter parameters and counts the rest", () => {
		const rows = ["a", "b", "c", "d", "e"].map((field) => ({ axis: "filterable" as const, row: { field } }))
		expect(describeWithheld(rows)).toBe(
			"the `a`, `b`, `c` query parameters and 2 more, which the list operation does not declare",
		)
	})
})

describe("filterIsGuess", () => {
	const guess = { source: "heuristic" } as const
	it("is a guess only when the heuristic filled the axis and nothing stated or harvested it", () => {
		expect(filterIsGuess({ tag: guess }, caps())).toBe(true)
		expect(filterIsGuess({ tag: { source: "tag" } }, caps())).toBe(false)
		expect(filterIsGuess({ tag: null }, caps())).toBe(false)
		expect(filterIsGuess({ entity: { filterable: [] }, tag: guess }, caps())).toBe(false)
		expect(filterIsGuess({ global: { filterable: [] }, tag: guess }, caps())).toBe(false)
		expect(filterIsGuess({ tag: guess }, caps({ filterableFrom: { path: "$" } }))).toBe(false)
		expect(filterIsGuess({ tag: guess }, caps({ hook: true }))).toBe(false)
	})
})

describe("queryOver", () => {
	it("is the list's query with each axis read off the capabilities, or none without a query", () => {
		const tag: QueryCapability = { filterable: ["x"], searchable: [], selectable: [], sortable: [], source: "tag" }
		expect(queryOver(tag, caps())).toEqual({
			filterable: ["id", "enabled"],
			searchable: ["username"],
			selectable: ["id"],
			sortable: ["username"],
			source: "tag",
		})
		expect(queryOver(null, caps())).toBeNull()
	})
})
