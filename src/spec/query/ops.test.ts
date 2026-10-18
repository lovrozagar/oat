import { describe, expect, it } from "vitest"
import { FIELD_TYPES, FILTER_OPS, IMPLICIT_OPS, isFieldType, isFilterOp, isNulls, ORDERED_TYPES } from "./ops.ts"

describe("query tokens", () => {
	it("classifies tokens", () => {
		expect(isFilterOp("eq")).toBe(true)
		expect(isFilterOp("nope")).toBe(false)
		expect(isFieldType("string")).toBe(true)
		expect(isFieldType("blob")).toBe(false)
		expect(isNulls("first")).toBe(true)
		expect(isNulls("last")).toBe(true)
		expect(isNulls("middle")).toBe(false)
		expect(ORDERED_TYPES.has("number")).toBe(true)
		expect(ORDERED_TYPES.has("date")).toBe(true)
		expect(ORDERED_TYPES.has("string")).toBe(false)
	})

	it("lists every operator and type, and implies only the ops 0.7.0 wrote", () => {
		expect(FILTER_OPS).toHaveLength(13)
		expect(FIELD_TYPES).toEqual(["string", "number", "boolean", "date", "enum", "array"])
		expect(IMPLICIT_OPS).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "like"])
	})
})
