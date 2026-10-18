import { describe, expect, it } from "vitest"
import type { UploadRequest, UploadResolution } from "../../config/types/hooks.ts"
import { optionsOf, partsOf, PDF } from "./__fixtures__/options.ts"
import { encodeMultipart } from "./multipart.ts"

const SCHEMA = {
	properties: {
		doc: { format: "binary" },
		empty: { type: "string" },
		name: { type: "string" },
		tags: { type: "array" },
	},
	type: "object",
}
const FIELDS = { empty: null, name: "n", tags: ["a", "b"] }

/** A hook that answers every part with `answer`, and remembers what it was asked. */
function hook(answer: UploadResolution): {
	asked: UploadRequest[]
	resolveUpload: (r: UploadRequest) => Promise<UploadResolution>
} {
	const asked: UploadRequest[] = []
	return {
		asked,
		resolveUpload: async (request) => {
			asked.push(request)
			return answer
		},
	}
}

describe("encodeMultipart, file properties", () => {
	it("sends a generated file for a file property, and every other field by its encoding", async () => {
		const form = await encodeMultipart(optionsOf({ fields: FIELDS, schema: SCHEMA }))
		expect(partsOf(form)).toEqual([
			["doc", { name: "doc-baseline-0.bin", type: "application/octet-stream" }],
			["name", "n"],
			["tags", "a"],
			["tags", "b"],
		])
	})

	it("sends the file the caller names itself, without asking the hook", async () => {
		const asking = hook(null)
		const options = optionsOf({
			fields: { doc: PDF },
			schema: SCHEMA,
			uploads: { resolveUpload: asking.resolveUpload, seed: 1 },
		})
		expect(partsOf(await encodeMultipart(options))).toEqual([["doc", { name: "given.pdf", type: "application/pdf" }]])
		expect(asking.asked).toEqual([])
	})

	it("sends the hook's file, asking it once", async () => {
		const asking = hook(PDF)
		const options = optionsOf({ schema: SCHEMA, uploads: { resolveUpload: asking.resolveUpload, seed: 1 } })
		expect(partsOf(await encodeMultipart(options))).toEqual([["doc", { name: "given.pdf", type: "application/pdf" }]])
		expect(asking.asked.map((request) => request.field)).toEqual(["doc"])
	})
})

describe("encodeMultipart, field overrides", () => {
	it("sends exactly the hook's fields when they carry the file", async () => {
		const asking = hook({ fields: { doc: PDF, extra: "x" } })
		const options = optionsOf({
			fields: FIELDS,
			schema: SCHEMA,
			uploads: { resolveUpload: asking.resolveUpload, seed: 1 },
		})
		expect(partsOf(await encodeMultipart(options))).toEqual([
			["doc", { name: "given.pdf", type: "application/pdf" }],
			["extra", "x"],
		])
	})

	it("adds the hook's fields last when they do not, generating the file without asking again", async () => {
		const asking = hook({ fields: { extra: "x" } })
		const options = optionsOf({
			fields: { name: "n" },
			schema: SCHEMA,
			uploads: { resolveUpload: asking.resolveUpload, seed: 1 },
		})
		expect(partsOf(await encodeMultipart(options))).toEqual([
			["doc", { name: "doc-baseline-0.bin", type: "application/octet-stream" }],
			["name", "n"],
			["extra", "x"],
		])
		expect(asking.asked).toHaveLength(1)
	})
})

describe("encodeMultipart, additionalProperties", () => {
	const additional = {
		additionalProperties: { format: "binary" },
		properties: { name: { type: "string" } },
		required: ["name", "upload"],
	}

	it("sends the file under the required field no property names", async () => {
		const asking = hook(null)
		const options = optionsOf({
			fields: { name: "n" },
			schema: additional,
			uploads: { resolveUpload: asking.resolveUpload, seed: 1 },
		})
		expect(partsOf(await encodeMultipart(options))).toEqual([
			["name", "n"],
			["upload", { name: "upload-baseline-0.bin", type: "application/octet-stream" }],
		])
		expect(asking.asked.map((request) => request.field)).toEqual(["upload", "upload"])
	})

	it("sends no extra file when a property already is one, or no required field is left", async () => {
		const withFile = { ...additional, properties: { doc: { format: "binary" } }, required: ["doc", "upload"] }
		expect(partsOf(await encodeMultipart(optionsOf({ schema: withFile }))).map(([name]) => name)).toEqual(["doc"])
		const allSent = { ...additional, required: ["name"] }
		expect(partsOf(await encodeMultipart(optionsOf({ fields: { name: "n" }, schema: allSent })))).toEqual([
			["name", "n"],
		])
		const notFile = { additionalProperties: { type: "string" }, required: ["upload"] }
		expect(partsOf(await encodeMultipart(optionsOf({ schema: notFile })))).toEqual([])
	})
})
