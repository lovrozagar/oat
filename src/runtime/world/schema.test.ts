import { describe, expect, it } from "vitest"
import { modelOf, op } from "../checks/__fixtures__/harness.ts"
import { NOTE, notes, PAY } from "./__fixtures__/documents.ts"
import { requestSchemaOf, stringProperties } from "./schema.ts"

describe("requestSchemaOf", () => {
	it("is the create's request body schema, or null when it has none", () => {
		const model = modelOf(notes())
		expect(requestSchemaOf(op(model, "note.create"), model)).toMatchObject({ required: NOTE.required })
		expect(requestSchemaOf(op(model, "note.list"), model)).toBeNull()
	})

	it("refuses an operation of another model", () => {
		const other = modelOf(PAY)
		expect(() => requestSchemaOf(op(other, "pay.start"), modelOf(notes()))).toThrow(
			"pay.start is not an operation of this model",
		)
	})
})

describe("stringProperties", () => {
	it("names the top-level properties that hold text", () => {
		expect(
			stringProperties({
				properties: { a: { type: "string" }, b: { type: ["string", "null"] }, c: { type: "integer" }, d: true },
			}),
		).toEqual(["a", "b"])
		expect(stringProperties({})).toEqual([])
		expect(stringProperties(null)).toEqual([])
	})
})
