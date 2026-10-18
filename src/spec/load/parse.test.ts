import { describe, expect, it } from "vitest"
import { assertOpenApi, parseDocument } from "./parse.ts"

const DOC = { info: { title: "t", version: "1" }, openapi: "3.1.0", paths: {} }

describe("parseDocument", () => {
	it("reads JSON past a byte-order mark, and YAML", async () => {
		expect(await parseDocument(`﻿${JSON.stringify(DOC)}`, "a.json")).toEqual(DOC)
		expect((await parseDocument("openapi: 3.0.3\npaths: {}\n", "a.yaml")).openapi).toBe("3.0.3")
	})

	it("refuses an empty document", async () => {
		await expect(parseDocument("﻿ \n", "e.json")).rejects.toThrow("oat: e.json is empty")
	})

	it("tells a truncated document from a malformed one", async () => {
		await expect(parseDocument('{"openapi": "3.1.0", "paths": {', "t.json")).rejects.toThrow(
			/starts as JSON but does not parse: .*has 2 more opening than closing brackets, so it is most likely truncated — it ends after 31 bytes/,
		)
		await expect(parseDocument('[{"openapi": 3.1.0}]', "m.json")).rejects.toThrow(/appears complete/)
		await expect(parseDocument("{", "o.json")).rejects.toThrow(/1 more opening/)
	})

	it("names the source when YAML does not parse", async () => {
		await expect(parseDocument("a: [\n", "b.yaml")).rejects.toThrow(/^oat: could not parse b\.yaml as JSON or YAML: /)
	})
})

describe("assertOpenApi", () => {
	it("accepts an OpenAPI 3.x document", () => {
		expect(assertOpenApi(DOC, "s")).toBe(DOC)
		expect(assertOpenApi({ ...DOC, openapi: "3.0" }, "s")).toBeDefined()
	})

	it("refuses what parsed as something other than an object, showing what it was", () => {
		expect(() => assertOpenApi(`Not Found ${"x".repeat(80)}`, "s")).toThrow(
			`oat: s is not an OpenAPI document — it parsed as "Not Found ${"x".repeat(50)}"`,
		)
		expect(() => assertOpenApi(null, "s")).toThrow("it parsed as null")
		expect(() => assertOpenApi(7, "s")).toThrow("it parsed as 7")
		expect(() => assertOpenApi([1, 2], "s")).toThrow("it parsed as 1,2")
	})

	it("refuses Swagger 2, a document without a 3.x version, and one without paths", () => {
		expect(() => assertOpenApi({ paths: {}, swagger: "2.0" }, "s")).toThrow("s is Swagger 2.0")
		expect(() => assertOpenApi({ openapi: 3, paths: {} }, "s")).toThrow('no "openapi: 3.x" version field')
		expect(() => assertOpenApi({ openapi: "2.0", paths: {} }, "s")).toThrow('no "openapi: 3.x" version field')
		for (const paths of [undefined, null, [], "p"]) {
			expect(() => assertOpenApi({ openapi: "3.1.0", paths }, "s")).toThrow('no "paths" object')
		}
	})
})
