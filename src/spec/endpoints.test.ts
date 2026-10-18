import { describe, expect, it } from "vitest"
import { doc } from "./__fixtures__/documents.ts"
import { listEndpoints, MUTATING_METHODS } from "./endpoints.ts"
import type { OperationObject } from "./types.ts"

const id = { in: "path", name: "id", required: true }

describe("listEndpoints", () => {
	it("lifts every operation with its method and path, naming an unnamed one by its route", () => {
		const endpoints = listEndpoints(
			doc({
				"/a": { get: { operationId: "a.get" }, post: {}, summary: "not an operation", trace: { operationId: "t" } },
				"/b": null,
				"/c": "text",
				"/d": { delete: null, put: 3 },
			}),
		)
		expect(endpoints.map((e) => [e.method, e.path, e.operationId])).toEqual([
			["get", "/a", "a.get"],
			["post", "/a", "POST /a"],
		])
	})

	it("reads a document without paths as having no operations", () => {
		expect(listEndpoints({ openapi: "3.1.0" })).toEqual([])
	})

	it("folds the path item's parameters in, letting the operation override one by name and location", () => {
		const own = { in: "query", name: "id" }
		const overriding = { ...id, description: "own" }
		const [endpoint] = listEndpoints(
			doc({
				"/x/{id}": { get: { parameters: [own, overriding] }, parameters: [id, { in: "header", name: "h" }, null] },
			}),
		)
		expect(endpoint?.op.parameters).toEqual([{ in: "header", name: "h" }, own, overriding])
	})

	it("keeps the operation as it is when nothing is shared or every shared parameter is overridden", () => {
		const op: OperationObject = { parameters: [{ in: "path", name: "id" }] }
		const bare: OperationObject = { operationId: "bare" }
		const [overridden] = listEndpoints(doc({ "/x/{id}": { get: op, parameters: [id] } }))
		const [empty] = listEndpoints(doc({ "/y": { get: bare, parameters: [] } }))
		const [notList] = listEndpoints(doc({ "/z": { get: bare, parameters: "no" } }))
		expect(overridden?.op).toBe(op)
		expect(empty?.op).toBe(bare)
		expect(notList?.op).toBe(bare)
		const [inherited] = listEndpoints(doc({ "/w/{id}": { get: bare, parameters: [id] } }))
		expect(inherited?.op.parameters).toEqual([id])
	})
})

describe("MUTATING_METHODS", () => {
	it("names the methods that change state, upper-case", () => {
		expect([...MUTATING_METHODS]).toEqual(["POST", "PUT", "PATCH", "DELETE"])
	})
})
