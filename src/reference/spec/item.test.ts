import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import type { ReferenceShape } from "../shapes/types.ts"
import { itemPathItem } from "./item.ts"
import type { JsonSchema } from "../../spec/types.ts"
import type { Json } from "./types.ts"

type Item = Record<string, Json & { responses: Json; requestBody: { content: Record<string, { schema: JsonSchema }> } }>

function item(shape: ReferenceShape, entity = TABLE): Item {
	return itemPathItem({ entities: ENTITIES, shape }, entity) as Item
}

describe("itemPathItem", () => {
	it("declares a delete, a read and a PATCH update", () => {
		expect(Object.keys(item({}))).toEqual(["delete", "get", "patch"])
	})

	it("declares a PUT update that replaces the record under the put shape", () => {
		const put = item({ updateMethod: "PUT" })
		expect(Object.keys(put)).toEqual(["delete", "get", "put"])
		expect(put["put"]?.requestBody.content["application/json"]?.schema.required).toContain("name")
		expect(item({})["patch"]?.requestBody.content["application/json"]?.schema.required).toEqual([])
	})
})

describe("the delete operation", () => {
	it("invalidates its own routes and the parent's derived reads", () => {
		expect(item({}, ROW)["delete"]?.["x-invalidate"]).toEqual([
			`GET ${ROW.collectionPath}`,
			`GET ${ROW.itemPath}`,
			`GET ${TABLE.collectionPath}`,
			`GET ${TABLE.itemPath}`,
		])
	})

	it("declares soft delete only where the entity has it", () => {
		expect(item({})["delete"]).toMatchObject({ operationId: "table.delete", "x-soft-delete": "deleted_at" })
		expect(item({}, JOB)["delete"]).not.toHaveProperty("x-soft-delete")
		expect(Object.keys(item({})["delete"]?.responses ?? {})).toEqual(["200", "400", "401", "403", "404"])
	})
})

describe("the read operation", () => {
	it("declares the record and its tenant", () => {
		expect(item({})["get"]).toMatchObject({
			operationId: "table.get",
			summary: "Get table",
			tags: ["Table"],
			"x-entity": { action: "read", identity: "id", name: "table" },
			"x-tenant": "project_id",
		})
	})

	it("declares the strong ETag its answer carries", () => {
		expect(item({})["get"]?.responses["200"]).toMatchObject({
			headers: { ETag: { schema: { type: "string" } } },
		})
	})

	it("locates the record under the record envelope", () => {
		expect(item({ recordEnvelope: true })["get"]?.["x-entity"]).toHaveProperty("recordPath", "$.data")
	})
})

describe("the update operation", () => {
	it("declares generated and immutable fields and what it invalidates", () => {
		const patch = item({})["patch"]
		expect(patch?.["x-generated"]).toContain("id")
		expect(patch?.["x-immutable"]).toEqual(TABLE.fields.filter((f) => f.immutable === true).map((f) => f.name))
		expect(patch?.["x-invalidate"]).toEqual([`GET ${TABLE.collectionPath}`, `GET ${TABLE.itemPath}`])
		expect(Object.keys(patch?.responses ?? {})).toEqual(["200", "400", "401", "403", "404", "409", "412", "415"])
	})

	it("takes an optional If-Match, and declares its 412 under every shape", () => {
		const parameters = item({})["patch"]?.["parameters"] as Json[]
		expect(parameters.at(-1)).toEqual({
			description: "Apply the update only while the record's ETag is one of these",
			in: "header",
			name: "If-Match",
			required: false,
			schema: { type: "string" },
		})
		expect(Object.keys(item({ rangeStatuses: true })["patch"]?.responses ?? {})).toEqual(["412", "2XX", "default"])
	})
})
