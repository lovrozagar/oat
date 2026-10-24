import { describe, expect, it } from "vitest"
import { query } from "../__fixtures__/documents.ts"
import type { CollectionShape } from "../collection/shape.ts"
import { deriveQueryConventions } from "./derive.ts"

const TEMPLATE = { ops: { eq: "eq" }, term: "{field}[{op}]={value}" }
const SORT_TEMPLATE = { asc: "a", desc: "d", term: "{field}:{direction}" }
const int = (name: string) => query(name, { type: "integer" })

const paged: CollectionShape = {
	envelopeKeys: [],
	itemSchema: null,
	key: "items",
	pagination: { countKey: "total", cursorKey: "next", hasMoreKey: "more", limitKey: "per", pageKey: "at" },
} as unknown as CollectionShape

describe("deriveQueryConventions", () => {
	it("assumes equality and the dotted sort where a document says nothing", () => {
		expect(deriveQueryConventions([], null)).toEqual({
			envelope: {},
			grammar: "equality",
			selectGrammar: "csv",
			sortGrammar: "dotted",
		})
	})

	it("names every role's parameter, the Link header and the envelope, in a fixed order", () => {
		const conventions = deriveQueryConventions(
			[
				{ in: "header", name: "q" },
				query("where", { type: "array" }),
				query("sort"),
				query("fields"),
				query("q"),
				query("mode"),
				query("after"),
				int("limit"),
				int("page"),
				int("offset"),
			],
			paged,
			{ responseHeaders: ["X-Total", "link"] },
		)
		expect(Object.keys(conventions)).toEqual([
			"envelope",
			"grammar",
			"selectGrammar",
			"sortGrammar",
			"linkHeader",
			"filter",
			"order",
			"select",
			"search",
			"searchMode",
			"cursor",
			"limit",
			"page",
			"offset",
		])
		expect(conventions).toMatchObject({ cursor: "after", filter: "where", linkHeader: "link", searchMode: "mode" })
		expect(conventions.envelope).toEqual({
			hasMore: "more",
			limit: "per",
			nextCursor: "next",
			page: "at",
			total: "total",
		})
		expect(Object.keys(conventions.envelope)).toEqual(["total", "hasMore", "nextCursor", "page", "limit"])
	})
})

describe("deriveQueryConventions roles", () => {
	it("leaves a bare `mode` alone unless a search parameter is present", () => {
		expect(deriveQueryConventions([query("mode")], null).searchMode).toBeUndefined()
		expect(deriveQueryConventions([query("mode")], null, { responseHeaders: ["X-Next"] }).linkHeader).toBeUndefined()
	})
})

describe("deriveQueryConventions filter grammar", () => {
	it("takes a declared filter grammar, by name or as a template", () => {
		expect(deriveQueryConventions([], null, { declared: { grammar: "colon" } })).toMatchObject({
			grammar: "colon",
			grammarDeclared: true,
		})
		const template = deriveQueryConventions([], null, { declared: { grammar: TEMPLATE } })
		expect(Object.keys(template).slice(0, 4)).toEqual(["envelope", "grammar", "filterGrammar", "grammarDeclared"])
		expect(template.grammar).toBe("template")
		expect(template.filterGrammar?.term).toBe(TEMPLATE.term)
	})

	it("calls a free-text filter it cannot read unrecognized, and says so only when nothing was declared", () => {
		const guesses: string[] = []
		const filter = [query("filter")]
		expect(deriveQueryConventions(filter, null, { onGuess: (message) => guesses.push(message) }).grammar).toBe(
			"unrecognized",
		)
		expect(guesses).toHaveLength(1)
		expect(guesses[0]).toMatch(/^parameter "filter" takes a filter expression whose grammar could not be recognized/)
		expect(deriveQueryConventions(filter, null).grammar).toBe("unrecognized")
		const declared = deriveQueryConventions(filter, null, {
			declared: { grammar: { term: 1 } },
			onGuess: (message) => guesses.push(message),
		})
		expect(declared.grammar).toBe("unrecognized")
		expect(declared.grammarDeclared).toBeUndefined()
		expect(guesses).toHaveLength(1)
		expect(deriveQueryConventions([int("filter")], null).grammar).toBe("equality")
		expect(
			deriveQueryConventions([query("filter", { type: "string" }, { description: "name.eq.x" })], null).grammar,
		).toBe("postgrest")
	})
})

describe("deriveQueryConventions sort grammar", () => {
	it("takes a declared sort grammar, by name or as a template, and infers one it cannot read", () => {
		expect(deriveQueryConventions([], null, { declared: { sortGrammar: "spaced" } })).toMatchObject({
			sortDeclared: true,
			sortGrammar: "spaced",
		})
		const template = deriveQueryConventions([], null, { declared: { sortGrammar: SORT_TEMPLATE } })
		expect(template).toMatchObject({ sortDeclared: true, sortGrammar: "template" })
		expect(template.sortSpec?.term).toBe(SORT_TEMPLATE.term)
		const order = [query("sort", { type: "string" }, { description: "e.g. -name" })]
		for (const sortGrammar of ["upward", { term: 1 }, null]) {
			const inferred = deriveQueryConventions(order, null, { declared: { sortGrammar } })
			expect(inferred.sortGrammar).toBe("prefixed")
			expect(inferred.sortDeclared).toBeUndefined()
		}
	})
})
