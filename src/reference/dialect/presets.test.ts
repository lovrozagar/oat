import { describe, expect, it } from "vitest"
import { deriveCollectionShape } from "../../spec/collection/shape.ts"
import { isAliasOf } from "../../spec/conventions/roles.ts"
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
		expect(TEMPLATE).toMatchObject({ grammar: "template", params: { filter: "filter_by" }, sortGrammar: "template" })
		expect(TEMPLATE.filterTemplate).toMatchObject({ escape: { _: "~" }, term: "{conj}_{field}_{op}_{value}" })
	})
})

describe("the template preset's parameter names", () => {
	it("are names no alias of their role finds, so only x-query.params can", () => {
		expect(TEMPLATE.declaresNames).toBe(true)
		for (const [role, name] of Object.entries(TEMPLATE.params)) {
			expect(isAliasOf(name, role as keyof typeof TEMPLATE.params), `${role}: ${name}`).toBe(false)
		}
		expect(Object.values(DIALECTS).filter((dialect) => dialect.declaresNames === true)).toEqual([TEMPLATE])
	})
})

describe("the template preset's envelope names", () => {
	it("are fields no alias finds for the total or the more-pages flag, so only x-query.envelope can", () => {
		const { total, hasMore } = TEMPLATE.envelope ?? {}
		expect({ hasMore, total }).toEqual({ hasMore: "more_ahead", total: "tally" })
		const shape = deriveCollectionShape({
			properties: {
				[hasMore as string]: { type: "boolean" },
				results: { items: { type: "object" }, type: "array" },
				[total as string]: { type: "integer" },
			},
			type: "object",
		})
		expect(shape?.pagination).toEqual({})
	})
})
