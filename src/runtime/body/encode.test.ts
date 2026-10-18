import { describe, expect, it } from "vitest"
import type { UploadRequest } from "../../config/types/hooks.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { bodiesModel, optionsOf, partsOf } from "./__fixtures__/options.ts"
import { encodeForOperation, encodeRequest, requestContentOf } from "./encode.ts"

const resolveInput = async (request: { field: string }): Promise<unknown> =>
	request.field === "name" ? "hooked" : null

function operation(operationId: string): OperationModel {
	const op = bodiesModel().byOperationId.get(operationId)
	if (op === undefined) throw new Error(`fixture has no ${operationId}`)
	return op
}

describe("requestContentOf", () => {
	it("is the body the operation documents, or null", () => {
		const model = bodiesModel()
		expect(requestContentOf(operation("docs.replace"), model)?.mediaType).toBe("application/json")
		expect(requestContentOf(operation("docs.list"), model)).toBeNull()
		expect(requestContentOf({ ...operation("docs.list"), operationId: "unknown" }, model)).toBeNull()
	})
})

describe("encodeRequest", () => {
	it("lets the input hook replace fields before encoding", async () => {
		const options = optionsOf({
			fields: { name: "n" },
			mediaType: "application/json",
			uploads: { resolveInput, seed: 1 },
		})
		expect(await encodeRequest(options)).toEqual({ body: { name: "hooked" }, contentType: undefined })
	})

	it("writes multipart as FormData, urlencoded as URLSearchParams, and anything else as the fields", async () => {
		const schema = { properties: { name: { type: "string" } }, type: "object" }
		const multipart = await encodeRequest(
			optionsOf({ fields: { name: "n", stray: "s" }, mediaType: "Multipart/Form-Data", schema }),
		)
		expect([partsOf(multipart.body as FormData), multipart.contentType]).toEqual([[["name", "n"]], null])
		const form = await encodeRequest(
			optionsOf({
				encoding: { tags: { explode: false } },
				fields: { tags: ["a", "b"] },
				mediaType: "application/x-www-form-urlencoded",
			}),
		)
		expect([(form.body as URLSearchParams).toString(), form.contentType]).toEqual([
			"tags=a%2Cb",
			"application/x-www-form-urlencoded",
		])
		expect(await encodeRequest(optionsOf({ fields: { a: 1 }, mediaType: "application/json" }))).toEqual({
			body: { a: 1 },
			contentType: undefined,
		})
	})
})

describe("encodeForOperation", () => {
	it("leaves the fields as they are for an operation without a body", async () => {
		const fields = { a: 1 }
		expect(await encodeForOperation(operation("docs.list"), bodiesModel(), { fields, uploads: { seed: 1 } })).toEqual({
			body: fields,
			contentType: undefined,
		})
	})

	it("encodes by the operation's media type and encoding, as the baseline's first record by default", async () => {
		const asked: UploadRequest[] = []
		const uploads = { resolveUpload: async (request: UploadRequest) => (asked.push(request), null), seed: 1 }
		const created = await encodeForOperation(operation("docs.create"), bodiesModel(), {
			fields: { tags: ["a", "b"] },
			uploads,
		})
		expect(partsOf(created.body as FormData).map(([name]) => name)).toEqual(["tags", "tags", "file"])
		expect(asked.map((request) => [request.variant, request.index])).toEqual([["baseline", 0]])
		await encodeForOperation(operation("docs.create"), bodiesModel(), {
			fields: {},
			index: 3,
			uploads,
			variant: "edge",
		})
		expect(asked.at(-1)).toMatchObject({ index: 3, variant: "edge" })
		const updated = await encodeForOperation(operation("docs.update"), bodiesModel(), {
			fields: { tags: ["a", "b"] },
			uploads,
		})
		expect((updated.body as URLSearchParams).toString()).toBe("tags=a%2Cb")
		const replaced = await encodeForOperation(operation("docs.replace"), bodiesModel(), {
			fields: { name: "n" },
			uploads,
		})
		expect(replaced).toEqual({ body: { name: "n" }, contentType: undefined })
	})
})
