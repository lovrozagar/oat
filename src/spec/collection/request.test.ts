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

describe("requestContent for an upload", () => {
	it("prefers multipart, with its file part, over JSON listed beside it, and sees urlencoded as a body", () => {
		const extract = body({
			"application/json": { schema: { properties: { text: { type: "string" } }, type: "object" } },
			"multipart/form-data": {
				schema: { properties: { file: { format: "binary", type: "string" }, text: { type: "string" } } },
			},
		})
		expect(requestContent(extract)?.mediaType).toBe("multipart/form-data")
		expect(requestSchema(extract)?.properties).toHaveProperty("file")
		const login = body({ "application/x-www-form-urlencoded": { schema: { type: "object" } } })
		expect(requestContent(login)?.mediaType).toBe("application/x-www-form-urlencoded")
	})
})

/** A pet's body as JSON or a form: an object property, an array of scalars and one of objects. */
const pet = (encoding?: Record<string, unknown>) => ({
	"application/json": { schema: { type: "object" } },
	"application/x-www-form-urlencoded": {
		...(encoding === undefined ? {} : { encoding }),
		schema: {
			properties: {
				category: { properties: { id: { type: "integer" } }, type: "object" },
				name: { type: "string" },
				photoUrls: { items: { type: "string" }, type: "array" },
				tags: { items: { properties: { id: { type: "integer" } }, type: "object" }, type: "array" },
			},
			type: "object",
		},
	},
})

describe("requestContent for a form that cannot carry the body", () => {
	it("sends JSON over a form that cannot carry the body: an object, or an array of objects, spread into keys", () => {
		expect(requestContent(body(pet()))?.mediaType).toBe("application/json")
		/* An array of objects alone is enough, and so is an object property alone. */
		const tagsOnly = { category: { contentType: "application/json" } }
		expect(requestContent(body(pet(tagsOnly)))?.mediaType).toBe("application/json")
		const categoryOnly = { tags: { contentType: "application/json" } }
		expect(requestContent(body(pet(categoryOnly)))?.mediaType).toBe("application/json")
		/* Each written as JSON, or the object as a deepObject, the form carries it, and is the contract. */
		const carried = { category: { style: "deepObject" }, tags: { contentType: "application/json" } }
		expect(requestContent(body(pet(carried)))?.mediaType).toBe("application/x-www-form-urlencoded")
		/* With no JSON beside it, the form is all there is. */
		const { "application/json": _json, ...formOnly } = pet()
		expect(requestContent(body(formOnly))?.mediaType).toBe("application/x-www-form-urlencoded")
	})
})
