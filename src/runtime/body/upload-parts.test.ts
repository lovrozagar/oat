import { describe, expect, it } from "vitest"
import type { UploadRequest } from "../../config/types/hooks.ts"
import { optionsOf, PDF } from "./__fixtures__/options.ts"
import { fileForPart, filePartNames, overrideIncludesFile, uploadRequest } from "./upload-parts.ts"

const FIXTURE = { filename: "f.png", index: 0, path: "/nowhere/f.png", total: 1 }

describe("overrideIncludesFile", () => {
	it("is true only for a file under one of the body's file part names", () => {
		expect(overrideIncludesFile({ doc: PDF, note: "n" }, ["doc"])).toBe(true)
		expect(overrideIncludesFile({ other: PDF }, ["doc"])).toBe(false)
		expect(overrideIncludesFile({ doc: "not a file" }, ["doc"])).toBe(false)
	})
})

describe("filePartNames", () => {
	it("is every file property, by schema or by encoding", () => {
		const options = optionsOf({ encoding: { avatar: { contentType: "image/png" } } })
		const properties = { avatar: { type: "string" }, doc: { format: "binary" }, name: { type: "string" } }
		expect(filePartNames(properties, [], options)).toEqual(["avatar", "doc"])
	})

	it("is the required field a file-typed additionalProperties names, when no property is a file", () => {
		const options = optionsOf({ schema: { additionalProperties: { format: "binary" } } })
		expect(filePartNames({ name: {} }, ["name", "upload"], options)).toEqual(["upload"])
		expect(filePartNames({ name: {} }, ["name"], options)).toEqual([])
		expect(filePartNames({ name: {} }, ["upload"], optionsOf())).toEqual([])
	})
})

describe("uploadRequest", () => {
	it("asks for the part by field, operation and variant, with what the schema knows of the file", () => {
		expect(uploadRequest("doc", {}, optionsOf({ index: 2, variant: "edge" }))).toEqual({
			field: "doc",
			index: 2,
			mediaType: "multipart/form-data",
			operationId: "docs.create",
			variant: "edge",
		})
		const options = optionsOf({
			encoding: { doc: { contentType: "image/png" } },
			uploads: { fixture: FIXTURE, seed: 1 },
		})
		expect(uploadRequest("doc", { filename: "x.png" }, options)).toEqual({
			contentMediaType: "image/png",
			field: "doc",
			filename: "x.png",
			fixture: FIXTURE,
			index: 0,
			mediaType: "multipart/form-data",
			operationId: "docs.create",
			variant: "baseline",
		})
	})
})

describe("fileForPart", () => {
	it("is the hook's file when it gives one", async () => {
		const asked: UploadRequest[] = []
		const options = optionsOf({ uploads: { resolveUpload: async (request) => (asked.push(request), PDF), seed: 1 } })
		expect(await fileForPart("doc", { format: "binary" }, options)).toBe(PDF)
		expect(asked.map((request) => [request.field, request.contentMediaType])).toEqual([
			["doc", "application/octet-stream"],
		])
	})

	it("is a generated file of the declared type otherwise", async () => {
		const file = await fileForPart("doc", { contentMediaType: "image/png" }, optionsOf())
		expect([file.filename, file.mediaType]).toEqual(["doc-baseline-0.png", "image/png"])
	})
})
