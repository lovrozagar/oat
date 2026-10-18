import { describe, expect, it } from "vitest"
import { PDF, partsOf } from "./__fixtures__/options.ts"
import { appendFields, appendFile, appendValue } from "./form-data.ts"

describe("appendFile / appendFields", () => {
	it("appends a file part under its name and type, and text fields as text", async () => {
		const form = new FormData()
		appendFile(form, "doc", PDF)
		appendFields(form, { note: "n", other: PDF })
		expect(partsOf(form)).toEqual([
			["doc", { name: "given.pdf", type: "application/pdf" }],
			["note", "n"],
			["other", { name: "given.pdf", type: "application/pdf" }],
		])
		expect([...new Uint8Array(await (form.get("doc") as File).arrayBuffer())]).toEqual([...PDF.bytes])
	})
})

describe("appendValue", () => {
	it("sends JSON when the encoding says so, and an object as a JSON part", async () => {
		const form = new FormData()
		appendValue(form, "meta", "x", { contentType: "application/json" })
		appendValue(form, "obj", { a: 1 }, undefined)
		expect(partsOf(form)).toEqual([
			["meta", { name: "blob", type: "application/json" }],
			["obj", { name: "blob", type: "application/json" }],
		])
		expect(await (form.get("obj") as File).text()).toBe('{"a":1}')
	})

	it("sends a part per array item, and scalars as text", () => {
		const form = new FormData()
		appendValue(form, "tags", ["a", { b: 1 }, null], { contentType: "text/plain" })
		appendValue(form, "n", 3, undefined)
		appendValue(form, "nil", null, undefined)
		expect(partsOf(form)).toEqual([
			["tags", "a"],
			["tags", { name: "blob", type: "application/json" }],
			["tags", "null"],
			["n", "3"],
			["nil", "null"],
		])
	})
})
