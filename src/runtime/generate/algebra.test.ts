import { describe, expect, it } from "vitest"
import { isObject, isVacuous, merge, mergeAll, typesOf } from "./algebra.ts"

describe("isObject", () => {
	it("is a plain object, not null or an array", () => {
		expect(isObject({})).toBe(true)
		expect(isObject(null)).toBe(false)
		expect(isObject([])).toBe(false)
		expect(isObject("x")).toBe(false)
	})
})

describe("isVacuous", () => {
	it("admits anything: true, {}, or annotations and extensions alone", () => {
		expect(isVacuous(true)).toBe(true)
		expect(isVacuous({})).toBe(true)
		expect(isVacuous({ description: "any", "x-note": 1 })).toBe(true)
		expect(isVacuous({ type: "string" })).toBe(false)
		expect(isVacuous(false)).toBe(false)
	})
})

describe("merge", () => {
	it("takes a keyword only one side sets", () => {
		expect(merge({ type: "string" }, { maxLength: 3 })).toEqual({ maxLength: 3, type: "string" })
	})

	it("unions properties and required", () => {
		expect(merge({ properties: { a: {} }, required: ["a"] }, { properties: { b: {} }, required: ["a", "b"] })).toEqual({
			properties: { a: {}, b: {} },
			required: ["a", "b"],
		})
	})

	it("intersects bounds: the larger minimum, the smaller maximum", () => {
		expect(
			merge(
				{
					exclusiveMaximum: 9,
					exclusiveMinimum: 1,
					maxItems: 4,
					maxLength: 9,
					maximum: 9,
					minItems: 1,
					minLength: 1,
					minimum: 1,
				},
				{
					exclusiveMaximum: 8,
					exclusiveMinimum: 2,
					maxItems: 3,
					maxLength: 8,
					maximum: 8,
					minItems: 2,
					minLength: 2,
					minimum: 2,
				},
			),
		).toEqual({
			exclusiveMaximum: 8,
			exclusiveMinimum: 2,
			maxItems: 3,
			maxLength: 8,
			maximum: 8,
			minItems: 2,
			minLength: 2,
			minimum: 2,
		})
	})
})

describe("merge, patterns", () => {
	it("adds a third pattern beside the residual ones, once", () => {
		const two = merge({ pattern: "^a" }, { pattern: "b$" })
		expect(merge(two, { pattern: "c" })).toEqual({ allOf: [{ pattern: "b$" }, { pattern: "c" }], pattern: "^a" })
		expect(merge(two, { pattern: "b$" })).toEqual(two)
	})

	it("joins two allOf lists rather than keeping only the second", () => {
		expect(merge({ allOf: [{ pattern: "a" }] }, { allOf: [{ pattern: "b" }] })).toEqual({
			allOf: [{ pattern: "a" }, { pattern: "b" }],
		})
	})

	it("keeps both of two patterns: the first at the top, the second a residual allOf", () => {
		expect(merge({ pattern: "^[a-z]+$" }, { pattern: "^[^\\u0000]*$" })).toEqual({
			allOf: [{ pattern: "^[^\\u0000]*$" }],
			pattern: "^[a-z]+$",
		})
		expect(merge({ pattern: "^a" }, { pattern: "^a" })).toEqual({ pattern: "^a" })
	})

	it("keeps every pattern an allOf's branches set", () => {
		const own = "^\\+[1-9]\\d{7,14}$"
		const guard = "^[^\\u0000\\uD800-\\uDFFF]*$"
		expect(mergeAll({ allOf: [{ pattern: own }, { pattern: guard }], type: "string" }, "/p")).toEqual({
			allOf: [{ pattern: guard }],
			pattern: own,
			type: "string",
		})
	})
})

describe("merge, keyword by keyword", () => {
	it("keeps the enum values both allow", () => {
		expect(merge({ enum: ["a", { b: 1 }, "c"] }, { enum: [{ b: 1 }, "c"] })).toEqual({ enum: [{ b: 1 }, "c"] })
	})

	it("keeps the types both allow, an integer inside a number, one type as itself", () => {
		expect(merge({ type: ["string", "null"] }, { type: "string" })).toEqual({ type: "string" })
		expect(merge({ type: "integer" }, { type: "number" })).toEqual({ type: "integer" })
		expect(merge({ type: ["string", "null"] }, { type: ["null", "string"] })).toEqual({ type: ["string", "null"] })
		expect(merge({ type: "string" }, { type: "boolean" })).toEqual({ type: [] })
	})

	it("merges nested schemas and overwrites anything else", () => {
		expect(merge({ items: { type: "string" } }, { items: { maxLength: 2 } })).toEqual({
			items: { maxLength: 2, type: "string" },
		})
		expect(merge({ format: "date" }, { format: "uuid" })).toEqual({ format: "uuid" })
		expect(merge({ const: 1 }, { const: { a: 1 } })).toEqual({ const: { a: 1 } })
	})

	it("treats a keyword named like an Object.prototype member as a plain keyword", () => {
		expect(merge({ constructor: "a" }, { constructor: "b" })).toEqual({ constructor: "b" })
	})
})

describe("mergeAll", () => {
	it("folds every object branch, nested allOf included, and drops allOf", () => {
		expect(
			mergeAll(
				{
					allOf: [{ properties: { a: {} } }, "not a schema", { allOf: [{ required: ["a"] }], properties: { b: {} } }],
					type: "object",
				},
				"",
			),
		).toEqual({ properties: { a: {}, b: {} }, required: ["a"], type: "object" })
	})

	it("refuses an allOf that is not a list, naming the value and the allOf within its schema", () => {
		expect(() => mergeAll({ allOf: { a: 1 } }, "/x")).toThrow(
			expect.objectContaining({ pointer: "/x", reason: "allOf is not a list of schemas" }),
		)
		expect(() => mergeAll({ allOf: [{ allOf: 5 }] }, "")).toThrow(
			expect.objectContaining({ reason: "allOf/0/allOf is not a list of schemas" }),
		)
	})
})

describe("typesOf", () => {
	it("reads the declared type, or infers one from the keywords", () => {
		expect(typesOf({ type: "integer" })).toEqual(["integer"])
		expect(typesOf({ type: ["string", 3, "null"] })).toEqual(["string", "null"])
		expect(typesOf({ properties: {} })).toEqual(["object"])
		expect(typesOf({ required: ["a"] })).toEqual(["object"])
		expect(typesOf({ items: {} })).toEqual(["array"])
		expect(typesOf({ prefixItems: [] })).toEqual(["array"])
		expect(typesOf({ multipleOf: 2 })).toEqual(["number"])
		expect(typesOf({ format: "date" })).toEqual(["string"])
	})
})
