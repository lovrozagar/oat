import { describe, expect, it } from "vitest"
import { query } from "../__fixtures__/documents.ts"
import type { JsonSchema, ParameterObject } from "../types.ts"
import { parameterNamed, resolvePagingRoles, roleName, schemaOf } from "./roles.ts"

const int = (name: string, schema: JsonSchema = {}): ParameterObject => query(name, { type: "integer", ...schema })

describe("roleName", () => {
	it("matches aliases whatever their case, separators or bracketed suffix", () => {
		expect(roleName([query("perPage")], "limit")).toBe("perPage")
		expect(roleName([query("Order-By")], "order")).toBe("Order-By")
		expect(roleName([query("search term")], "search")).toBe("search term")
		expect(roleName([query("filter[status]")], "filter")).toBe("filter[status]")
		expect(roleName([query("x"), query("q"), query("search")], "search")).toBe("q")
	})

	it("is undefined when no parameter plays the role", () => {
		expect(roleName([query("x")], "cursor")).toBeUndefined()
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
