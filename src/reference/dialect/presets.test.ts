import { describe, expect, it } from "vitest"
import { CLASSIC, DIALECTS, JSONAPI, LINKED, PLAIN, POSTGREST, TEMPLATE } from "./presets.ts"

describe("DIALECTS", () => {
	it("names every preset by its own name", () => {
		expect(DIALECTS).toEqual({
			classic: CLASSIC,
			jsonapi: JSONAPI,
			linked: LINKED,
			plain: PLAIN,
			postgrest: POSTGREST,
			template: TEMPLATE,
		})
		for (const [name, dialect] of Object.entries(DIALECTS)) expect(dialect.name).toBe(name)
	})

	it("spells the canonical grammar with cursors, and the classic one with nothing in common", () => {
		expect(POSTGREST).toMatchObject({ grammar: "postgrest", params: { cursor: "cursor", searchMode: "search_mode" } })
		const postgrestNames = new Set([...Object.values(POSTGREST.params), ...Object.values(POSTGREST.envelope ?? {})])
		const shared = Object.values(CLASSIC.params).filter(
			(name) => postgrestNames.has(name) && name !== "page" && name !== "filter",
		)
		expect(shared).toEqual([])
		expect(CLASSIC).toMatchObject({ envelope: { collection: "data" }, grammar: "colon" })
	})
})

describe("the other presets", () => {
	it("page by Link header and offset with no envelope", () => {
		expect(LINKED.envelope).toBeNull()
		expect(LINKED.params.offset).toBe("offset")
		expect(LINKED.params.page).toBeUndefined()
	})

	it("write sorts and projections in the JSON:API spelling", () => {
		expect(JSONAPI).toMatchObject({ selectGrammar: "bracketed", sortGrammar: "prefixed" })
	})

	it("have no filter expression in the plain shape, and a declared template in the template one", () => {
		expect(PLAIN).toMatchObject({ grammar: "equality", sortGrammar: "colon" })
		expect(TEMPLATE).toMatchObject({ grammar: "template", params: { filter: "where" }, sortGrammar: "template" })
		expect(TEMPLATE.filterTemplate).toMatchObject({ escape: { _: "~" }, term: "{conj}_{field}_{op}_{value}" })
	})
})
