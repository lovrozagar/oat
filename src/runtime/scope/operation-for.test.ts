import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { referenceModel } from "./__fixtures__/models.ts"
import { operationFor } from "./operation-for.ts"

const model = referenceModel()

describe("operationFor", () => {
	it("finds the operation an exchange hit, below the base path, or none", () => {
		const table = operationFor(
			model,
			{ method: "GET", url: "http://h.test/api/v1/projects/p1/tables/t1" },
			"http://h.test/api",
		)
		expect(table?.operationId).toBe("table.get")
		expect(operationFor(model, { method: "GET", url: "http://h.test/api/nowhere" }, "http://h.test/api")).toBeNull()
		expect(operationFor(model, { method: "GET", url: "not a url" }, "http://h.test")).toBeNull()
	})

	it("matches with no base path, and prefers literal segments on a tie", () => {
		expect(
			operationFor(model, { method: "get", url: "http://h.test/v1/projects/p1/tables" }, "http://h.test/")?.operationId,
		).toBe("table.list")
		expect(
			operationFor(model, { method: "POST", url: "http://h.test/v1/projects/p1/tables/t1/rows" }, "http://h.test")
				?.operationId,
		).toBe("row.create")
		const ok = { "200": { description: "ok" } }
		const id = [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
		const things = buildModel({
			info: { title: "things", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/things/special": { get: { operationId: "thing.special", responses: ok } },
				"/things/{id}": { get: { operationId: "thing.get", parameters: id, responses: ok } },
			},
		} as unknown as OpenApiDocument)
		/* The literal route comes first and the parameter route matches too: the literal stays. */
		expect(
			operationFor(things, { method: "GET", url: "http://h.test/things/special" }, "http://h.test")?.operationId,
		).toBe("thing.special")
		expect(operationFor(things, { method: "GET", url: "http://h.test/things/t1" }, "http://h.test")?.operationId).toBe(
			"thing.get",
		)
		/* The base path is not a prefix of this URL: the whole path is tried. */
		expect(
			operationFor(model, { method: "GET", url: "http://h.test/v1/projects/p1/tables" }, "http://h.test/elsewhere")
				?.operationId,
		).toBe("table.list")
	})
})
