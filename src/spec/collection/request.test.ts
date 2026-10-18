import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { hasRequestBody, requestContent, requestSchema } from "./request.ts"

const body = (content: Record<string, unknown> | undefined) => ({ requestBody: { content } }) as OperationObject

describe("requestContent", () => {
	it("prefers multipart, then urlencoded, then JSON, then the first listed", () => {
		const content = {
			"application/json": { schema: { type: "object" } },
			"application/x-www-form-urlencoded": { schema: { type: "string" } },
			"multipart/form-data": { encoding: { file: { contentType: "image/png" } }, schema: { type: "array" } },
			"text/plain": {},
		}
		expect(requestContent(body(content))).toEqual({
			encoding: { file: { contentType: "image/png" } },
			mediaType: "multipart/form-data",
			schema: { type: "array" },
		})
		const { "multipart/form-data": _multipart, ...rest } = content
		expect(requestContent(body(rest))?.mediaType).toBe("application/x-www-form-urlencoded")
		expect(requestContent(body({ "text/csv": {}, "application/json": {} }))?.mediaType).toBe("application/json")
		expect(requestContent(body({ "text/csv": {}, "text/plain": {} }))).toEqual({ mediaType: "text/csv", schema: {} })
	})

	it("takes the preferred type when the operation documents it", () => {
		const content = { "application/json": {}, "multipart/form-data": {} }
		expect(requestContent(body(content), "application/json")?.mediaType).toBe("application/json")
		expect(requestContent(body(content), "text/xml")?.mediaType).toBe("multipart/form-data")
	})

	it("reads a media type written with no body as one without a schema", () => {
		expect(requestContent(body({ "application/json": null }))).toEqual({ mediaType: "application/json", schema: {} })
	})

	it("is null without a body", () => {
		expect(requestContent({} as OperationObject)).toBeNull()
		expect(requestContent(body(undefined))).toBeNull()
		expect(requestContent(body({}))).toBeNull()
	})
})

describe("hasRequestBody and requestSchema", () => {
	it("say whether a body is documented, and its schema", () => {
		expect(hasRequestBody(body({ "application/json": {} }))).toBe(true)
		expect(hasRequestBody(body({}))).toBe(false)
		expect(hasRequestBody({} as OperationObject)).toBe(false)
		expect(requestSchema(body({ "application/json": { schema: { type: "object" } } }))).toEqual({ type: "object" })
		expect(requestSchema({} as OperationObject)).toBeNull()
	})
})
