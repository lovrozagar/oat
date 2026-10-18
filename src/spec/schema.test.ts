import { describe, expect, it } from "vitest"
import { normalizeSchema } from "./schema.ts"
import type { SchemaObject } from "./types.ts"

const response = { direction: "response" } as const
const request = { direction: "request" } as const

describe("normalizeSchema", () => {
	it("drops OpenAPI-only keywords from schema nodes, but not a property named like one", () => {
		const schema = {
			discriminator: { propertyName: "kind" },
			example: { id: 1 },
			externalDocs: {},
			properties: { example: { type: "string", xml: {} } },
			type: "object",
		}
		expect(normalizeSchema(schema, response)).toEqual({
			properties: { example: { type: "string" } },
			type: "object",
		})
	})

	it("translates every subschema it holds, and leaves anything else where a subschema could be", () => {
		const schema = {
			additionalProperties: false,
			allOf: [{ nullable: true, type: "string" }, true],
			items: { example: 1, type: "integer" },
			not: { example: "x" },
			patternProperties: { "^x-": { example: 1 }, "^y-": true },
			properties: "not a map",
		}
		expect(normalizeSchema(schema, response)).toEqual({
			additionalProperties: false,
			allOf: [{ type: ["string", "null"] }, true],
			items: { type: "integer" },
			not: {},
			patternProperties: { "^x-": {}, "^y-": true },
			properties: "not a map",
		})
	})
})

describe("normalizeSchema bounds and tuples", () => {
	it("reads draft-04 tuple items as prefixItems", () => {
		expect(normalizeSchema({ items: [{ example: 1, type: "integer" }, false] }, response)).toEqual({
			prefixItems: [{ type: "integer" }, false],
		})
	})

	it("reads OpenAPI 3.0's boolean exclusive bounds as 2020-12 numbers", () => {
		expect(normalizeSchema({ exclusiveMinimum: true, maximum: 9, minimum: 1 }, response)).toEqual({
			exclusiveMinimum: 1,
			maximum: 9,
		})
		expect(normalizeSchema({ exclusiveMaximum: true }, response)).toEqual({})
		expect(normalizeSchema({ exclusiveMaximum: false, maximum: 9 }, response)).toEqual({ maximum: 9 })
		expect(normalizeSchema({ exclusiveMinimum: 0 }, response)).toEqual({ exclusiveMinimum: 0 })
	})
})

describe("normalizeSchema directions and nulls", () => {
	it("drops the properties that do not travel in the direction, and stops requiring them", () => {
		const schema = {
			properties: { id: { readOnly: true }, name: {}, secret: { writeOnly: true }, raw: 5 },
			required: ["id", "name", "secret"],
		}
		expect(normalizeSchema(schema, request)).toEqual({
			properties: { name: {}, raw: 5, secret: { writeOnly: true } },
			required: ["name", "secret"],
		})
		expect(normalizeSchema(schema, response)).toEqual({
			properties: { id: { readOnly: true }, name: {}, raw: 5 },
			required: ["id", "name"],
		})
		expect(normalizeSchema({ properties: { id: { readOnly: true } }, required: "id" }, request)).toEqual({
			properties: {},
			required: "id",
		})
	})

	it("widens a nullable schema exactly where it can, and by a union where it cannot", () => {
		expect(normalizeSchema({ enum: ["a"], nullable: true, type: "string" }, response)).toEqual({
			enum: ["a", null],
			type: ["string", "null"],
		})
		expect(normalizeSchema({ enum: ["a", null], nullable: true, type: ["string", "null"] }, response)).toEqual({
			enum: ["a", null],
			type: ["string", "null"],
		})
		expect(normalizeSchema({ allOf: [{ type: "string" }], nullable: true, type: "string" }, response)).toEqual({
			anyOf: [{ allOf: [{ type: "string" }], type: "string" }, { type: "null" }],
		})
		expect(normalizeSchema({ minLength: 1, nullable: true }, response)).toEqual({
			anyOf: [{ minLength: 1 }, { type: "null" }],
		})
	})

	it("translates a cyclic schema into a cyclic schema, and never mutates its input", () => {
		const node: SchemaObject = { example: 1, type: "object" }
		node.properties = { child: node }
		const out = normalizeSchema(node, response)
		expect((out.properties as Record<string, unknown>).child).toBe(out)
		expect(node.example).toBe(1)
	})
})
