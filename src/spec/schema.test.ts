import { describe, expect, it } from "vitest"
import { normalizeSchema, scalarKinds } from "./schema.ts"
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

describe("scalarKinds", () => {
	it("reads a scalar type, and nothing else", () => {
		expect(scalarKinds({ type: "string" })).toEqual(["string"])
		expect(scalarKinds({ type: "integer" })).toEqual(["integer"])
		expect(scalarKinds({ type: "object" })).toBeUndefined()
		expect(scalarKinds({ type: "null" })).toBeUndefined()
		expect(scalarKinds({})).toBeUndefined()
		expect(scalarKinds(null)).toBeUndefined()
		expect(scalarKinds("string")).toBeUndefined()
	})

	it("reads a 3.1 type list, nulls aside, and an empty or null-only list as no scalar", () => {
		expect(scalarKinds({ type: ["string", "null"] })).toEqual(["string"])
		expect(scalarKinds({ type: ["string", "integer"] })).toEqual(["string", "integer"])
		expect(scalarKinds({ type: [] })).toBeUndefined()
		expect(scalarKinds({ type: ["null"] })).toBeUndefined()
		expect(scalarKinds({ type: ["string", "object"] })).toBeUndefined()
		expect(scalarKinds({ type: [1] })).toBeUndefined()
	})

	it("keeps the 3.0 nullable flag out of it: the type decides", () => {
		expect(scalarKinds({ nullable: true, type: "string" })).toEqual(["string"])
		expect(scalarKinds({ nullable: true, type: "object" })).toBeUndefined()
	})

	it("reads oneOf and anyOf with null branches beside scalars, but not null alone", () => {
		expect(scalarKinds({ oneOf: [{ type: "string" }, { type: "null" }] })).toEqual(["string"])
		expect(scalarKinds({ anyOf: [{ type: "integer" }, { type: ["string", "null"] }] })).toEqual(["integer", "string"])
		expect(scalarKinds({ oneOf: [{ type: "null" }] })).toBeUndefined()
		expect(scalarKinds({ oneOf: [] })).toBeUndefined()
		expect(scalarKinds({ oneOf: [{ type: "string" }, { type: "object" }] })).toBeUndefined()
		expect(scalarKinds({ oneOf: [{ type: "string" }, 1] })).toBeUndefined()
	})

	it("reads an untyped enum or const by its values", () => {
		expect(scalarKinds({ enum: ["a", "b", null] })).toEqual(["string"])
		expect(scalarKinds({ enum: [1, 2.5, true] })).toEqual(["number", "boolean"])
		expect(scalarKinds({ const: "fixed" })).toEqual(["string"])
		expect(scalarKinds({ enum: [null] })).toBeUndefined()
		expect(scalarKinds({ enum: [] })).toBeUndefined()
		expect(scalarKinds({ enum: ["a", { b: 1 }] })).toBeUndefined()
		expect(scalarKinds({ const: [1] })).toBeUndefined()
	})

	it("reads allOf with exactly one typed branch, the description-beside-a-ref idiom", () => {
		expect(scalarKinds({ allOf: [{ type: "string" }, { description: "the name" }] })).toEqual(["string"])
		expect(scalarKinds({ allOf: [{ type: "string" }, { maxLength: 4, type: "string" }] })).toBeUndefined()
		expect(scalarKinds({ allOf: [{ type: "object" }, { description: "x" }] })).toBeUndefined()
		expect(scalarKinds({ allOf: [{ description: "x" }] })).toBeUndefined()
	})
})

describe("normalizeSchema for an ordinary writer", () => {
	it("drops an optional x-privileged property for an ordinary writer alone, and keeps a required one", () => {
		const schema = {
			properties: { name: {}, plan: { "x-privileged": true }, verified: { "x-privileged": true } },
			required: ["name", "plan"],
		}
		expect(normalizeSchema(schema, { direction: "request", ordinary: true })).toEqual({
			properties: { name: {}, plan: { "x-privileged": true } },
			required: ["name", "plan"],
		})
		expect(normalizeSchema(schema, request)).toEqual(schema)
		expect(
			normalizeSchema({ properties: { verified: { "x-privileged": true } } }, { direction: "request", ordinary: true }),
		).toEqual({
			properties: {},
		})
	})
})

describe("normalizeSchema discriminator", () => {
	const KEY = "x-oat-discriminator"
	const cat: SchemaObject = { properties: { kind: { type: "string" }, meow: { type: "boolean" } }, type: "object" }
	const dog: SchemaObject = { properties: { bark: { type: "boolean" } }, required: ["bark"], type: "object" }
	const tags = { propertyName: "kind", values: [["cat", "kitty"], ["dog"]] }

	it("pins each branch's tag to its values and requires it, in both directions", () => {
		const schema = { discriminator: { propertyName: "kind" }, oneOf: [cat, dog], [KEY]: tags }
		const expected = {
			oneOf: [
				{
					properties: { kind: { enum: ["cat", "kitty"], type: "string" }, meow: { type: "boolean" } },
					required: ["kind"],
					type: "object",
				},
				{
					properties: { bark: { type: "boolean" }, kind: { enum: ["dog"] } },
					required: ["bark", "kind"],
					type: "object",
				},
			],
		}
		expect(normalizeSchema(schema, response)).toEqual(expected)
		expect(normalizeSchema(schema, request)).toEqual(expected)
		/* The branches themselves, reached elsewhere, are left as they are. */
		expect((normalizeSchema({ items: [cat, schema] }, response).prefixItems as unknown[])[0]).toEqual(cat)
	})

	it("tags an anyOf, a branch that is a ref, and keeps a tag already required", () => {
		const ref = { $ref: "oat-defs#/$defs/Cat", required: ["kind"] }
		const schema = { anyOf: [ref, false], [KEY]: { propertyName: "kind", values: [["cat"], ["dog"]] } }
		expect(normalizeSchema(schema, response)).toEqual({
			anyOf: [{ $ref: "oat-defs#/$defs/Cat", properties: { kind: { enum: ["cat"] } }, required: ["kind"] }, false],
		})
	})

	it("leaves the union open when the tag does not travel in this direction, or the record does not fit", () => {
		const hidden = { properties: { kind: { readOnly: true, type: "string" } } }
		const schema = { oneOf: [cat, dog], [KEY]: tags }
		expect(normalizeSchema({ ...schema, ...hidden }, request).oneOf).toEqual([cat, dog])
		expect((normalizeSchema({ oneOf: [hidden, dog], [KEY]: tags }, request).oneOf as unknown[])[1]).toEqual(dog)
		expect(normalizeSchema({ oneOf: [cat], [KEY]: tags }, response).oneOf).toEqual([cat])
		expect(normalizeSchema({ oneOf: [cat, dog], [KEY]: { propertyName: 1 } }, response).oneOf).toEqual([cat, dog])
		expect(normalizeSchema({ [KEY]: tags }, response)).toEqual({})
	})
})
