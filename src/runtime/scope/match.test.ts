import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { referenceModel } from "./__fixtures__/models.ts"
import { matchPattern } from "./match.ts"
import { ScopeError } from "./scope-error.ts"

const model = referenceModel()

describe("matchPattern", () => {
	it("matches an exact operationId outright", () => {
		expect(matchPattern("table.get", model, "table.get")).toEqual({ exact: true, ids: ["table.get"] })
	})

	it("matches METHOD /path for an operation without an operationId, the method in any case", () => {
		const unnamed = buildModel({
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: { "/v1/pay": { post: { responses: { "200": { description: "ok" } } } } },
		} as unknown as OpenApiDocument)
		expect(matchPattern("post /v1/pay", unnamed, "post /v1/pay")).toEqual({ exact: true, ids: ["POST /v1/pay"] })
		expect(() => matchPattern("post /v1/pay/", unnamed, "post /v1/pay/")).toThrow(ScopeError)
	})

	it("expands a glob within an operationId, escaping everything else", () => {
		expect(matchPattern("row.*", model, "row.*").ids.sort()).toEqual([
			"row.create",
			"row.delete",
			"row.get",
			"row.list",
			"row.update",
		])
		expect(matchPattern("row.*", model, "row.*").exact).toBe(false)
		expect(() => matchPattern("row?*", model, "row?*")).toThrow(ScopeError)
	})

	it("refuses a pattern that matches nothing, suggesting the nearest for an exact one", () => {
		expect(() => matchPattern("table.craete", model, "cdn:table.craete")).toThrow(
			'oat: --ops "cdn:table.craete" matches no operation. Did you mean: table.create, table.delete, table.get?',
		)
		expect(() => matchPattern("zzzzzz", model, "zzzzzz")).toThrow('oat: --ops "zzzzzz" matches no operation.')
		expect(() => matchPattern("nothing.*", model, "nothing.*")).toThrow('oat: --ops "nothing.*" matches no operation.')
	})
})
