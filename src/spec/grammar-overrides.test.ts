import { describe, expect, it } from "vitest"
import { doc, list, member, ok, query } from "./__fixtures__/documents.ts"
import { applyGrammarOverrides } from "./grammar-overrides.ts"
import { buildModel } from "./graph/build.ts"
import { dereference } from "./load/dereference.ts"

const TEMPLATE = { ops: { eq: "eq" }, term: "{field}[{op}]={value}" }
const SORT_TEMPLATE = { asc: "a", desc: "d", term: "{field}:{direction}" }

/* Notes declare a template filter and sort grammar; tags declare nothing. */
const model = () =>
	buildModel(
		dereference(
			doc({
				"/notes": {
					get: {
						operationId: "notes.list",
						parameters: [query("filter"), query("sort")],
						responses: ok(list(member)),
						"x-entity": { action: "list", name: "note" },
						"x-query": { grammar: TEMPLATE, sortGrammar: SORT_TEMPLATE },
					},
				},
				"/tags": { get: { operationId: "tags.list", parameters: [query("sort")], responses: ok(list(member)) } },
				"/ping": { get: { operationId: "ping", responses: ok({ type: "object" }) } },
			}),
		).doc,
	)

const conventionsOf = (config: Parameters<typeof applyGrammarOverrides>[1]) => {
	const m = model()
	applyGrammarOverrides(m, config)
	return Object.fromEntries(m.operations.map((op) => [op.operationId, op.conventions]))
}

describe("applyGrammarOverrides", () => {
	it("lays the run's named grammars over every operation, dropping a declared template", () => {
		const out = conventionsOf({ query: { grammar: "colon", sortGrammar: "prefixed" } })
		expect(out["notes.list"]).toMatchObject({ grammar: "colon", grammarDeclared: true, sortDeclared: true })
		expect(out["notes.list"]?.sortGrammar).toBe("prefixed")
		expect(out["notes.list"]?.filterGrammar).toBeUndefined()
		expect(out["notes.list"]?.sortSpec).toBeUndefined()
		expect(out["ping"]).toMatchObject({ grammar: "colon", sortGrammar: "prefixed" })
	})

	it("lays templates over operations, and an entity's grammars over the run's", () => {
		const out = conventionsOf({
			entities: { note: { query: { grammar: "equality", sortGrammar: "spaced" } }, other: undefined },
			query: { grammar: TEMPLATE, sortGrammar: SORT_TEMPLATE },
		})
		expect(out["notes.list"]).toMatchObject({ grammar: "equality", sortGrammar: "spaced" })
		expect(out["tags.list"]).toMatchObject({ grammar: "template", sortGrammar: "template" })
		expect(out["tags.list"]?.filterGrammar?.term).toBe(TEMPLATE.term)
		expect(out["tags.list"]?.sortSpec).toBeDefined()
	})

	it("changes nothing when config declares nothing", () => {
		const out = conventionsOf({ entities: { note: {} } })
		expect(out["notes.list"]).toMatchObject({ grammar: "template", sortGrammar: "template" })
		expect(out["tags.list"]?.grammarDeclared).toBeUndefined()
	})

	it("stops on a grammar config names but oat cannot read", () => {
		expect(() => conventionsOf({ query: { grammar: 5 as never } })).toThrow(
			'query.grammar must be "postgrest", "colon", "equality" or a template object',
		)
		expect(() => conventionsOf({ query: { grammar: null as never } })).toThrow("query.grammar must be")
		expect(() => conventionsOf({ query: { grammar: { term: 1 } as never } })).toThrow(/^query\.grammar: /)
		expect(() => conventionsOf({ entities: { note: { query: { sortGrammar: "up" as never } } } })).toThrow(
			'entities.note.query.sortGrammar must be "dotted", "prefixed", "colon", "spaced" or a template object',
		)
		expect(() => conventionsOf({ query: { sortGrammar: null as never } })).toThrow("query.sortGrammar must be")
		expect(() => conventionsOf({ query: { sortGrammar: { key: 1 } as never } })).toThrow(/^query\.sortGrammar: /)
	})
})
