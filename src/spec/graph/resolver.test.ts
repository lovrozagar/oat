import { describe, expect, it } from "vitest"
import { member, ok } from "../__fixtures__/documents.ts"
import { modelOf } from "./__fixtures__/operations.ts"
import { operationResolver } from "./resolver.ts"

const resolve = operationResolver(
	modelOf({
		"/tables/{id}": {
			get: { operationId: "tables.get", responses: { ...ok(member), "302": { description: "moved" } } },
		},
		"/tables/archived": {
			get: {
				operationId: "tables.archived",
				parameters: [
					{ in: "query", name: "v", required: true, schema: { const: "1" } },
					{ example: { a: 1 }, in: "query", name: "f", required: true, style: "deepObject" },
					{ example: "2", in: "header", name: "X-Version", required: true },
					{ example: "en", in: "cookie", name: "lang", required: true },
				],
				responses: ok(member),
			},
		},
		"/health": {
			get: {
				operationId: "health",
				responses: ok({ type: "object" }),
				"x-consistency": { bypass: "X-Fresh: 1", staleness: "30s" },
			},
		},
		"/tables/{id}/rows/{row}": { get: { operationId: "rows.get", responses: { "3XX": { description: "elsewhere" } } } },
	}),
)

describe("operationResolver", () => {
	it("maps a request to the most specific documented template, whatever the method's case", () => {
		expect(resolve("get", "/tables/archived")).toEqual({
			bypass: null,
			entity: "table",
			operationId: "tables.archived",
			paramStyles: { query: { f: { style: "deepObject" } } },
			pathParams: {},
			redirects: false,
			requiredCookies: { lang: "en" },
			requiredHeaders: { "X-Version": "2" },
			requiredQuery: { f: { a: 1 }, v: "1" },
			template: "/tables/archived",
		})
		expect(resolve("GET", "/tables/t%201")).toMatchObject({ operationId: "tables.get", pathParams: { id: "t 1" } })
	})

	it("carries the bypass a read declares in x-consistency, and none for one that declares none", () => {
		expect(resolve("GET", "/health")?.bypass).toEqual({ name: "x-fresh", value: "1" })
		expect(resolve("GET", "/tables/t1")?.bypass).toBeNull()
	})

	it("reads a documented 3xx, exact or as a range, as an answer to grade", () => {
		expect(resolve("GET", "/tables/t1")?.redirects).toBe(true)
		expect(resolve("GET", "/tables/t1/rows/r1")?.redirects).toBe(true)
	})

	it("reads the path parameters off the operation the request resolved to", () => {
		const tables = operationResolver(
			modelOf({
				"/projects/{project_id}/tables": { get: { operationId: "table.list", responses: ok(member) } },
				"/projects/{project_id}/tables/{table_id}": { get: { operationId: "table.read", responses: ok(member) } },
			}),
		)
		expect(tables("GET", "/projects/a/tables/t1")?.pathParams).toEqual({ project_id: "a", table_id: "t1" })
	})

	it("is null for a method or a path the document does not have", () => {
		expect(resolve("DELETE", "/tables/t1")).toBeNull()
		expect(resolve("GET", "/chairs")).toBeNull()
	})
})
