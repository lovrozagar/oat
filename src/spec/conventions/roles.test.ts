import { describe, expect, it } from "vitest"
import { query } from "../__fixtures__/documents.ts"
import type { JsonSchema, ParameterObject } from "../types.ts"
import { isAliasOf, parameterNamed, resolveRoles, type Role, schemaOf } from "./roles.ts"

const int = (name: string, schema: JsonSchema = {}): ParameterObject => query(name, { type: "integer", ...schema })
/* The parameter aliases alone give a role, as an operation that names none sees it. */
const roleName = (params: readonly ParameterObject[], role: Role) => resolveRoles(params, {}).roles[role]
const resolvePagingRoles = (params: readonly ParameterObject[]) => resolveRoles(params, {}).roles

describe("roles by alias", () => {
	it("matches aliases whatever their case, separators or bracketed suffix", () => {
		expect(roleName([int("perPage")], "limit")).toBe("perPage")
		expect(roleName([query("pageToken")], "cursor")).toBe("pageToken")
		expect(roleName([query("Order-By")], "order")).toBe("Order-By")
		expect(roleName([query("search term")], "search")).toBe("search term")
		expect(roleName([query("filter[status]")], "filter")).toBe("filter[status]")
		expect(roleName([query("x"), query("q"), query("search")], "search")).toBe("q")
	})

	it("is undefined when no parameter plays the role", () => {
		expect(roleName([query("x")], "cursor")).toBeUndefined()
	})

	it("passes over a search alias whose declaration says it takes key:value pairs, not free text", () => {
		/* Keycloak's users list: `q` searches custom attributes, `search` is the free text. */
		const attributes: ParameterObject = {
			...query("q"),
			description: "A query to search for custom attributes, in the format 'key1:value2 key2:value2'",
		}
		expect(roleName([attributes, query("search")], "search")).toBe("search")
		expect(roleName([attributes], "search")).toBeUndefined()
		expect(roleName([query("q", { examples: ["role:admin"], type: "string" })], "search")).toBe("q")
		expect(roleName([query("q", { examples: ["key:value"], type: "string" })], "search")).toBeUndefined()
		expect(roleName([query("q", { pattern: "^\\w+:\\w+$", type: "string" })], "search")).toBeUndefined()
		expect(roleName([query("search", { type: "boolean" }), query("term")], "search")).toBe("term")
		expect(roleName([{ ...query("q"), description: "Free-text search across name and email" }], "search")).toBe("q")
	})

	it("reads a structured description only for the search role", () => {
		const structured: ParameterObject = { ...query("filter"), description: "key:value pairs" }
		expect(roleName([structured], "filter")).toBe("filter")
	})
})

describe("parameterNamed and schemaOf", () => {
	it("find a parameter by name, and read its schema or an empty one", () => {
		const q = query("q")
		expect(parameterNamed([q], "q")).toBe(q)
		expect(parameterNamed([q], undefined)).toBeUndefined()
		expect(schemaOf(q)).toEqual({ type: "string" })
		expect(schemaOf({ in: "query", name: "bare" })).toEqual({})
	})
})

describe("resolvePagingRoles", () => {
	it("reads integer and number parameters by name, ignoring the rest", () => {
		expect(
			resolvePagingRoles([query("limit"), int("limit"), { ...int("page"), schema: { type: "number" } }, int("skip")]),
		).toEqual({
			limit: "limit",
			offset: "skip",
			page: "page",
		})
	})

	it("takes `count` as a page size only when it is bounded or defaulted", () => {
		expect(resolvePagingRoles([int("count", { maximum: 100 })])).toEqual({ limit: "count" })
		expect(resolvePagingRoles([int("count", { default: 20 })])).toEqual({ limit: "count" })
		expect(resolvePagingRoles([int("count")])).toEqual({})
	})

	it("refuses a bounded page number", () => {
		expect(resolvePagingRoles([int("page", { maximum: 5 })])).toEqual({})
	})

	it("reads an unnamed bounded, defaulted integer as a page size, and one starting at 1 as a page", () => {
		expect(resolvePagingRoles([int("n", { default: 10, maximum: 50 }), int("at", { minimum: 1 })])).toEqual({
			limit: "n",
			page: "at",
		})
	})

	it("gives each role to the first parameter that claims it", () => {
		expect(
			resolvePagingRoles([
				int("limit"),
				int("size"),
				int("page"),
				int("p"),
				int("offset"),
				int("skip"),
				int("n", { default: 10, maximum: 50 }),
				int("at", { minimum: 1 }),
			]),
		).toEqual({ limit: "limit", offset: "offset", page: "page" })
	})
})

describe("resolvePagingRoles over nullable numbers", () => {
	it("reads a 3.1 nullable integer and a nullable oneOf like the integer they are", () => {
		const roles = resolvePagingRoles([
			{ in: "query", name: "limit", schema: { maximum: 100, type: ["integer", "null"] } },
			{ in: "query", name: "page", schema: { minimum: 1, oneOf: [{ type: "integer" }, { type: "null" }] } },
		])
		expect(roles).toEqual({ limit: "limit", page: "page" })
	})

	it("passes over a parameter that is not one number kind", () => {
		expect(resolvePagingRoles([{ in: "query", name: "limit", schema: { type: ["integer", "string"] } }])).toEqual({})
	})
})

describe("resolveRoles with named parameters", () => {
	it("gives a named role the parameter of that name", () => {
		const filterBy = query("filter_by")
		expect(resolveRoles([query("q"), filterBy], { filter: "filter_by" })).toEqual({
			roles: { filter: "filter_by", search: "q" },
			unmatched: [],
		})
	})

	it("lists a name the operation does not declare and falls back to the role's alias", () => {
		expect(resolveRoles([query("where")], { filter: "filter_by" })).toEqual({
			roles: { filter: "where" },
			unmatched: [{ name: "filter_by", role: "filter" }],
		})
	})

	it("keeps a named parameter from being taken by another role's alias", () => {
		/* `query` is a filter alias; once named the search parameter, it is not the filter too. */
		expect(resolveRoles([query("query"), query("where")], { search: "query" }).roles).toEqual({
			filter: "where",
			search: "query",
		})
		expect(resolveRoles([query("query")], { search: "query" }).roles).toEqual({ search: "query" })
	})

	it("trusts a named search parameter that takes structured input", () => {
		const attributes: ParameterObject = { ...query("q"), description: "in the format 'key1:value2'" }
		expect(resolveRoles([attributes], { search: "q" }).roles).toEqual({ search: "q" })
	})

	it("lets named paging parameters outrank the schema reading, and still resolves an unnamed alias", () => {
		const params = [int("take", { default: 1, maximum: 9 }), int("leaf", { minimum: 1 }), int("offset"), int("limit")]
		expect(resolveRoles(params, { limit: "take", page: "leaf" }).roles).toEqual({
			limit: "take",
			offset: "offset",
			page: "leaf",
		})
	})

	it("matches a bracketed name exactly as declared", () => {
		expect(resolveRoles([query("filter[status]"), query("by")], { filter: "filter[status]" }).roles).toEqual({
			filter: "filter[status]",
		})
		expect(resolveRoles([query("filter[status]")], { filter: "filter" })).toEqual({
			roles: { filter: "filter[status]" },
			unmatched: [{ name: "filter", role: "filter" }],
		})
	})

	it("reads a bare mode as the search mode beside a named search parameter", () => {
		expect(resolveRoles([query("needle"), query("mode")], { search: "needle" }).roles).toEqual({
			search: "needle",
			searchMode: "mode",
		})
		expect(resolveRoles([query("mode")], {}).roles).toEqual({})
	})
})

describe("isAliasOf", () => {
	it("tells a name an alias of the role finds from one it does not", () => {
		expect(isAliasOf("perPage", "limit")).toBe(true)
		expect(isAliasOf("filter[status]", "filter")).toBe(true)
		expect(isAliasOf("take", "limit")).toBe(false)
		expect(isAliasOf("q", "filter")).toBe(false)
	})
})
