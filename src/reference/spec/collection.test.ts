import { describe, expect, it } from "vitest"
import { LINKED, POSTGREST } from "../dialect/presets.ts"
import { ENTITIES } from "../model/entities.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import type { ReferenceShape } from "../shapes/types.ts"
import { collectionPathItem, parentReadRoutes } from "./collection.ts"
import type { Json } from "./types.ts"

const CTX = { entities: ENTITIES, shape: {} }

interface Operation {
	parameters: Json[]
	requestBody: { content: Record<string, unknown> }
	responses: Record<string, Json>
	[key: string]: unknown
}

function operations(shape: ReferenceShape, name = "table"): { get: Operation; post: Operation } {
	const entities = shapedEntities(shape)
	const entity = entities.find((candidate) => candidate.name === name)
	return collectionPathItem({ entities, shape }, entity as never, POSTGREST) as never
}

describe("parentReadRoutes", () => {
	it("is the table's read routes for a row, and nothing for other entities", () => {
		expect(parentReadRoutes(CTX, ROW)).toEqual([`GET ${TABLE.collectionPath}`, `GET ${TABLE.itemPath}`])
		expect(parentReadRoutes(CTX, TABLE)).toEqual([])
		expect(parentReadRoutes({ entities: [ROW], shape: {} }, ROW)).toEqual([])
	})
})

describe("the list operation", () => {
	const { get } = operations({})

	it("takes the path, query and limit parameters", () => {
		const limit = get.parameters.at(-1)
		expect(get.parameters[0]).toMatchObject({ in: "path", name: "project_id" })
		expect(limit).toEqual({
			in: "query",
			name: POSTGREST.params.limit,
			required: false,
			schema: { default: TABLE.defaultLimit, maximum: TABLE.maxLimit, minimum: 1, type: "integer" },
		})
		expect(get.parameters.filter((param) => param.in === "query").every((param) => param.required === false)).toBe(true)
	})

	it("declares the listing, its tag, its query and its rate limit", () => {
		expect(get).toMatchObject({
			operationId: "table.list",
			summary: "List tables",
			tags: ["Table"],
			"x-entity": { action: "list", identity: "id", name: "table" },
			"x-rate-limit": { category: "table.list", rps: 500 },
			"x-soft-delete": "deleted_at",
			"x-tenant": "project_id",
		})
		expect(Object.keys(get.responses)).toEqual(["200", "400", "401", "403", "404"])
		expect(get["x-query"]).toHaveProperty("grammar", "postgrest")
	})

	it("declares Link headers for a dialect without an envelope", () => {
		const linked = collectionPathItem(CTX, TABLE, LINKED) as { get: Operation }
		expect(linked.get.responses["200"]?.headers).toHaveProperty("Link")
		expect(get.responses["200"]?.headers).toBeUndefined()
	})

	it("omits soft delete where the entity has none", () => {
		expect(operations({}, "job").get).not.toHaveProperty("x-soft-delete")
	})
})

describe("the create operation", () => {
	const { post } = operations({})

	it("accepts an idempotency key and a JSON body", () => {
		expect(post.parameters.at(-1)).toMatchObject({ in: "header", name: "Idempotency-Key", required: false })
		expect(Object.keys(post.requestBody.content)).toEqual(["application/json"])
		expect(Object.keys(post.responses)).toEqual(["201", "400", "401", "403", "404", "409", "415"])
	})

	it("declares generated fields, uniqueness and what it invalidates", () => {
		expect(post).toMatchObject({
			operationId: "table.create",
			"x-entity": { action: "create", identity: "id", name: "table" },
			"x-invalidate": [`GET ${TABLE.collectionPath}`],
			"x-unique": [["name"]],
		})
		expect(post["x-generated"]).toContain("id")
		const row = collectionPathItem(CTX, ROW, POSTGREST) as { post: Operation }
		expect(row.post["x-invalidate"]).toEqual([
			`GET ${ROW.collectionPath}`,
			`GET ${TABLE.collectionPath}`,
			`GET ${TABLE.itemPath}`,
		])
	})

	it("declares no uniqueness when none or an empty set is declared", () => {
		expect(operations({ tableKey: "slug" }).post).not.toHaveProperty("x-unique")
		expect((collectionPathItem(CTX, JOB, POSTGREST) as { post: Operation }).post).not.toHaveProperty("x-unique")
	})

	it("takes a form body under the form-create shape", () => {
		expect(Object.keys(operations({ formCreate: true }).post.requestBody.content)).toEqual([
			"application/x-www-form-urlencoded",
		])
	})

	it("answers an acknowledgement for a table under ack-create, and the record otherwise", () => {
		const ack = operations({ ackCreate: true }).post.responses["201"]
		expect(ack).toHaveProperty("content.application/json.schema.required", ["success"])
		const row = operations({ ackCreate: true }, "row").post.responses["201"]
		expect(row).toHaveProperty("content.application/json.schema.additionalProperties", false)
	})

	it("locates the record and the created id under the record envelope", () => {
		expect(operations({ recordEnvelope: true }).post["x-entity"]).toEqual({
			action: "create",
			createdIdFrom: "$.id",
			identity: "id",
			name: "table",
			recordPath: "$.data",
		})
	})
})
