import { describe, expect, it } from "vitest"
import { inferFieldType, inferTypesFromSchema } from "./infer-type.ts"

describe("schema type inference", () => {
	it("reads enum, format, scalar, nullable-union, and unknown", () => {
		expect(inferFieldType(undefined)).toBeUndefined()
		expect(inferFieldType({ enum: ["a"] })).toBe("enum")
		expect(inferFieldType({ enum: [], type: "string" })).toBe("string")
		expect(inferFieldType({ format: "date", type: "string" })).toBe("date")
		expect(inferFieldType({ format: "date-time", type: "string" })).toBe("date")
		expect(inferFieldType({ format: 1, type: "string" })).toBe("string")
		expect(inferFieldType({ type: "array" })).toBe("array")
		expect(inferFieldType({ type: "boolean" })).toBe("boolean")
		expect(inferFieldType({ type: "integer" })).toBe("number")
		expect(inferFieldType({ type: "number" })).toBe("number")
		expect(inferFieldType({ type: "string" })).toBe("string")
		expect(inferFieldType({ type: ["string", "null"] })).toBe("string")
		expect(inferFieldType({ type: ["string", "number"] })).toBeUndefined()
		expect(inferFieldType({ type: [1, "null"] })).toBeUndefined()
		expect(inferFieldType({ type: "object" })).toBeUndefined()
	})

	it("maps a schema's properties to the types it can infer", () => {
		expect(inferTypesFromSchema(null).size).toBe(0)
		expect(inferTypesFromSchema(undefined).size).toBe(0)
		expect(inferTypesFromSchema({}).size).toBe(0)
		expect(inferTypesFromSchema({ properties: null }).size).toBe(0)
		expect(inferTypesFromSchema({ properties: "x" }).size).toBe(0)
		const types = inferTypesFromSchema({
			properties: { blob: { type: "object" }, id: { type: "string" }, n: null, skip: 1 },
		})
		expect([...types]).toEqual([["id", "string"]])
	})
})

describe("schema type inference through the shared scalar reading", () => {
	it("reads a nullable oneOf, a single-branch allOf and an untyped const like their scalar", () => {
		expect(inferFieldType({ oneOf: [{ type: "integer" }, { type: "null" }] })).toBe("number")
		expect(inferFieldType({ allOf: [{ type: "boolean" }, { description: "flag" }] })).toBe("boolean")
		expect(inferFieldType({ const: "x" })).toBe("string")
		expect(inferFieldType({ format: "date", oneOf: [{ type: "string" }, { type: "null" }] })).toBe("date")
		expect(inferFieldType({ oneOf: [{ type: "null" }] })).toBeUndefined()
		expect(inferFieldType({ type: [] })).toBeUndefined()
	})
})
