import { describe, expect, it } from "vitest"
import { additionalSchema, contentMediaTypeOf, isFilePart, propertiesOf, requiredOf } from "./schema.ts"

describe("isFilePart", () => {
	it("knows a binary schema by its format, encoding or media type", () => {
		const files = [
			{ format: "binary" },
			{ format: "BYTE" },
			{ contentEncoding: "base64" },
			{ contentEncoding: "Binary" },
			{ contentMediaType: "image/png" },
		]
		expect(files.map((schema) => isFilePart(schema))).toEqual([true, true, true, true, true])
		expect(
			[{ contentMediaType: "application/json; charset=utf-8" }, { type: "string" }, null, "x"].map((s) =>
				isFilePart(s),
			),
		).toEqual([false, false, false, false])
	})

	it("knows a part the encoding gives a non-JSON type, and a union with a file branch", () => {
		expect(isFilePart({ type: "string" }, { contentType: "image/png" })).toBe(true)
		expect(isFilePart({ type: "string" }, { contentType: "application/vnd.api+json" })).toBe(false)
		expect(isFilePart({ type: "string" }, { contentType: "" })).toBe(false)
		expect(isFilePart({ oneOf: [{ type: "string" }, { format: "binary" }] })).toBe(true)
		expect(isFilePart({ anyOf: [{ type: "string" }] })).toBe(false)
	})
})

describe("contentMediaTypeOf", () => {
	it("is the encoding's first type, then the schema's, then octet-stream for a binary format", () => {
		expect(contentMediaTypeOf({}, { contentType: "image/png, image/jpeg" })).toBe("image/png")
		expect(contentMediaTypeOf({ contentMediaType: "application/pdf" }, { contentType: "" })).toBe("application/pdf")
		expect(contentMediaTypeOf({ contentMediaType: "", format: "Binary" })).toBe("application/octet-stream")
		expect(contentMediaTypeOf({ format: "byte" })).toBe("application/octet-stream")
		expect(contentMediaTypeOf({ format: "date" })).toBeUndefined()
		expect(contentMediaTypeOf({})).toBeUndefined()
	})
})

describe("schema parts", () => {
	it("reads properties that are schemas, and nothing from anything else", () => {
		expect(propertiesOf({ properties: { a: { type: "string" }, b: null, c: [1], d: "x" } })).toEqual({
			a: { type: "string" },
		})
		expect([propertiesOf({}), propertiesOf({ properties: null }), propertiesOf({ properties: [] })]).toEqual([
			{},
			{},
			{},
		])
	})

	it("reads the required names, and additionalProperties when it is a schema", () => {
		expect(requiredOf({ required: ["a", 1, "b"] })).toEqual(["a", "b"])
		expect(requiredOf({ required: "a" })).toEqual([])
		expect(additionalSchema({ additionalProperties: { format: "binary" } })).toEqual({ format: "binary" })
		expect(
			[true, null, [], undefined].map((additionalProperties) => additionalSchema({ additionalProperties })),
		).toEqual([undefined, undefined, undefined, undefined])
	})
})
