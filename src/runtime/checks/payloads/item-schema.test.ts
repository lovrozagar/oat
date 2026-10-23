import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../spec/graph/types.ts"
import type { OperationObject } from "../../../spec/types.ts"
import { itemSchemaOf } from "./item-schema.ts"

const record = { properties: { id: { type: "integer" }, name: { type: "string" } }, type: "object" }
const read = { operationId: "pet.get", recordPath: null } as OperationModel
const rawOperations = new Map<string, OperationObject>([
	["pet.get", { responses: { "200": { content: { "application/json": { schema: record } }, description: "ok" } } }],
	["pet.bare", { responses: { "204": { description: "no content" } } }],
])
const wrapped = { properties: { data: { $ref: "#/x", ...record } }, type: "object" }
const listed = { properties: { hits: { items: { properties: { doc: record }, type: "object" }, type: "array" } } }
rawOperations.set("pet.wrapped", {
	responses: { "200": { content: { "application/json": { schema: wrapped } }, description: "ok" } },
})
rawOperations.set("pet.listed", {
	responses: { "200": { content: { "application/json": { schema: listed } }, description: "ok" } },
})
const model = { rawOperations }

/** The record's schema from `operationId`'s answer, at `recordPath`. */
const at = (operationId: string, recordPath: string) =>
	itemSchemaOf({ listOp: undefined, model, readOp: { operationId, recordPath } as OperationModel })

describe("itemSchemaOf", () => {
	it("is the list's row schema when the entity has a list, even when the list says none", () => {
		const rows = { type: "object" }
		const listOp = { collection: { itemSchema: rows } } as OperationModel
		expect(itemSchemaOf({ listOp, model, readOp: read })).toBe(rows)
		expect(itemSchemaOf({ listOp: { collection: null } as OperationModel, model, readOp: read })).toBeNull()
	})

	it("is what the item read answers with when the entity has no list", () => {
		expect(itemSchemaOf({ listOp: undefined, model, readOp: read })).toEqual(record)
	})

	it("is none with no list and no read, or a read that documents no JSON body", () => {
		expect(itemSchemaOf({ listOp: undefined, model, readOp: undefined })).toBeNull()
		const bare = { operationId: "pet.bare", recordPath: null } as OperationModel
		expect(itemSchemaOf({ listOp: undefined, model, readOp: bare })).toBeNull()
	})

	it("is the record where the read's x-entity.recordPath says it is, as a dotted path or a JSON pointer", () => {
		expect(at("pet.wrapped", "$.data")?.properties).toEqual(record.properties)
		expect(at("pet.wrapped", "/data")?.properties).toEqual(record.properties)
		expect(at("pet.listed", "$.hits[0].doc")).toEqual(record)
		expect(at("pet.listed", "$.hits[*].doc")).toEqual(record)
		/* A path the schema does not hold, or one through a value with no properties, names no schema. */
		expect(at("pet.wrapped", "$.missing.id")).toBeNull()
		expect(at("pet.listed", "$.hits.doc")).toBeNull()
	})
})
