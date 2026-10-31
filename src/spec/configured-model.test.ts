import { describe, expect, it } from "vitest"
import { UsageError } from "../errors/usage-error.ts"
import { doc, list, member, ok, query } from "./__fixtures__/documents.ts"
import { buildConfiguredModel } from "./configured-model.ts"
import { dereference } from "./load/dereference.ts"

/* Two lists: one filters by `filter_by`, one by `where`. */
const searched = dereference(
	doc({
		"/v1/notes": {
			get: { operationId: "notes.list", parameters: [query("filter_by")], responses: ok(list(member)) },
		},
		"/v1/tags": { get: { operationId: "tags.list", parameters: [query("where")], responses: ok(list(member)) } },
	}),
).doc

const typo = () => buildConfiguredModel(searched, { query: { params: { filter: "filtr_by" } } })
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
		expect(() => buildConfiguredModel(searched, { query: { params: { sort: "arrange" } } })).toThrow(
			'query.params.sort names "arrange", which no operation declares',
		)
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
