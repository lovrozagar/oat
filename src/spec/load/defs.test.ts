import { describe, expect, it } from "vitest"
import { doc } from "../__fixtures__/documents.ts"
import { DEFS_ID, DEFS_KEY, documentDefs } from "./defs.ts"

describe("documentDefs", () => {
	it("returns the recursive schemas a dereferenced document carries", () => {
		const node = { type: "object" }
		expect(documentDefs(doc({}, { [DEFS_KEY]: { Node: node } }))).toEqual({ Node: node })
	})

	it("is empty when the document carries none, or carries something else under the key", () => {
		expect(documentDefs(doc({}))).toEqual({})
		expect(documentDefs(doc({}, { [DEFS_KEY]: null }))).toEqual({})
		expect(documentDefs(doc({}, { [DEFS_KEY]: "x" }))).toEqual({})
	})

	it("names where the definitions live", () => {
		expect([DEFS_ID, DEFS_KEY]).toEqual(["oat-defs", "x-oat-defs"])
	})
})
