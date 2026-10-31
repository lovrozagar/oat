import { describe, expect, it } from "vitest"
import { UsageError } from "../errors/usage-error.ts"
import { doc, list, member, ok, query } from "./__fixtures__/documents.ts"
import { assertQueryNamesDeclared, buildConfiguredModel } from "./configured-model.ts"
import { dereference } from "./load/dereference.ts"

/* Three lists, one filtering by `filter_by`, one by `where`, one answering its next cursor as `next_before`, and a read. */
const searched = dereference(
	doc({
		"/v1/notes": {
			get: { operationId: "notes.list", parameters: [query("filter_by")], responses: ok(list(member)) },
		},
		"/v1/tags": { get: { operationId: "tags.list", parameters: [query("where")], responses: ok(list(member)) } },
		"/v1/me": { get: { operationId: "me.read", responses: ok(member) } },
		"/v1/events": {
			get: {
				operationId: "events.list",
				parameters: [query("before", { type: "integer" })],
				responses: ok({ properties: { events: list(member), next_before: { type: "integer" } }, type: "object" }),
			},
		},
	}),
).doc

/* The names checked against the model of `searched` alone. */
const checked = (names: Record<string, unknown>) => () =>
	assertQueryNamesDeclared({ query: names }, [buildConfiguredModel(searched, { query: names })])
const typo = checked({ params: { filter: "filtr_by" } })
const built = (params: unknown) => () => buildConfiguredModel(searched, { query: { params: params as never } })
const filterOf = (model: ReturnType<typeof buildConfiguredModel>, id: string) =>
	model.byOperationId.get(id)?.conventions.filter

describe("buildConfiguredModel", () => {
	it("sends a role in the parameter config names, where an operation declares it", () => {
		const model = buildConfiguredModel(searched, { query: { params: { filter: "filter_by" } } })
		expect(filterOf(model, "notes.list")).toBe("filter_by")
		expect(filterOf(model, "tags.list")).toBe("where")
		expect(filterOf(buildConfiguredModel(searched, {}), "notes.list")).toBeUndefined()
	})

	it("lays config's grammars over the model as well", () => {
		const model = buildConfiguredModel(searched, { query: { grammar: "colon", params: { filter: "filter_by" } } })
		expect(model.byOperationId.get("notes.list")?.conventions).toMatchObject({ filter: "filter_by", grammar: "colon" })
	})

	it("stops on a name no operation declares", () => {
		expect(typo).toThrow(UsageError)
		expect(typo).toThrow('query.params.filter names "filtr_by", which no operation declares')
		expect(checked({ params: { sort: "arrange" } })).toThrow(
			'query.params.sort names "arrange", which no operation declares',
		)
	})

	it("builds with a name no operation declares, and takes one any model of the run declares", () => {
		const other = dereference(
			doc({
				"/v1/search": { get: { operationId: "search", parameters: [query("arrange")], responses: ok(list(member)) } },
			}),
		).doc
		const config = { query: { params: { sort: "arrange" } } }
		const model = buildConfiguredModel(searched, config)
		expect(model.byOperationId.has("notes.list")).toBe(true)
		expect(() => assertQueryNamesDeclared(config, [model, buildConfiguredModel(other, config)])).not.toThrow()
		expect(() => assertQueryNamesDeclared({}, [model])).not.toThrow()
		expect(checked({ envelope: { nextCursor: "next_before" }, params: { cursor: "before" } })).not.toThrow()
	})

	it("stops on params it cannot read", () => {
		expect(built("filter_by")).toThrow("query.params must be an object of role names")
		expect(built({ filtre: "filter_by" })).toThrow(
			'query.params names an unknown role "filtre"; the roles are filter, sort, select, search, searchMode, limit, page, offset, cursor',
		)
		expect(built({ filter: 3 })).toThrow("query.params.filter must be a parameter name")
		expect(built({ filter: "" })).toThrow("query.params.filter must be a parameter name")
	})
})

const enveloped = (envelope: unknown) => () =>
	buildConfiguredModel(searched, { query: { envelope: envelope as never } })

describe("buildConfiguredModel envelope names", () => {
	it("reads a fact from the field config names, where a list response holds it", () => {
		const model = buildConfiguredModel(searched, {
			query: { envelope: { nextCursor: "next_before" }, params: { cursor: "before" } },
		})
		expect(model.byOperationId.get("events.list")?.conventions).toMatchObject({
			cursor: "before",
			envelope: { nextCursor: "next_before" },
		})
		expect(model.byOperationId.get("tags.list")?.conventions.envelope).toEqual({})
	})

	it("stops on a name no list response declares", () => {
		expect(checked({ envelope: { nextCursor: "next_befor" } })).toThrow(
			'query.envelope.nextCursor names "next_befor", which no list response declares',
		)
	})

	it("stops on an envelope it cannot read", () => {
		expect(enveloped("next_before")).toThrow("query.envelope must be an object of role names")
		expect(enveloped({ page: "p" })).toThrow(
			'query.envelope names an unknown role "page"; the roles are total, hasMore, nextCursor',
		)
		expect(enveloped({ total: 3 })).toThrow("query.envelope.total must be a field name")
		expect(enveloped({ total: "" })).toThrow("query.envelope.total must be a field name")
	})
})
