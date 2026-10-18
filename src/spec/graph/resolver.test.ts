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
				parameters: [{ in: "query", name: "v", required: true, schema: { const: "1" } }],
				responses: ok(member),
			},
		},
		"/health": { get: { operationId: "health", responses: ok({ type: "object" }) } },
		"/tables/{id}/rows/{row}": { get: { operationId: "rows.get", responses: { "3XX": { description: "elsewhere" } } } },
	}),
)

describe("operationResolver", () => {
	it("maps a request to the most specific documented template, whatever the method's case", () => {
		expect(resolve("get", "/tables/archived")).toEqual({
			entity: "table",
			operationId: "tables.archived",
			pathParams: {},
			redirects: false,
			requiredQuery: { v: "1" },
			template: "/tables/archived",
		})
		expect(resolve("GET", "/tables/t%201")).toMatchObject({ operationId: "tables.get", pathParams: { id: "t 1" } })
	})

	it("reads a documented 3xx, exact or as a range, as an answer to grade", () => {
		expect(resolve("GET", "/tables/t1")?.redirects).toBe(true)
		expect(resolve("GET", "/tables/t1/rows/r1")?.redirects).toBe(true)
	})

	it("is null for a method or a path the document does not have", () => {
		expect(resolve("DELETE", "/tables/t1")).toBeNull()
		expect(resolve("GET", "/chairs")).toBeNull()
	})
})
