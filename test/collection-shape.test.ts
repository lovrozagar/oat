import { describe, expect, it } from "vitest"
import { deriveCollectionShape } from "../src/spec/collection.ts"
import type { SchemaObject } from "../src/spec/types.ts"

const item = { properties: { id: { type: "string" } }, type: "object" }

describe("deriveCollectionShape", () => {
	it("does not read a document with an array field as a list", () => {
		const document = {
			properties: {
				components: { properties: { schemas: { type: "object" } }, type: "object" },
				info: { properties: { title: { type: "string" } }, type: "object" },
				openapi: { type: "string" },
				paths: { additionalProperties: { type: "object" }, type: "object" },
				servers: { items: { properties: { url: { type: "string" } }, type: "object" }, type: "array" },
			},
			type: "object",
		} as SchemaObject
		expect(deriveCollectionShape(document)).toBeNull()
	})

	it("still reads a paged envelope", () => {
		const envelope = {
			properties: { has_more: { type: "boolean" }, items: { items: item, type: "array" }, total: { type: "integer" } },
			type: "object",
		} as SchemaObject
		expect(deriveCollectionShape(envelope)?.key).toBe("items")
	})

	it("still reads an envelope with a meta or links sidecar", () => {
		const envelope = {
			properties: {
				data: { items: item, type: "array" },
				links: { properties: { next: { type: "string" } }, type: "object" },
				meta: { properties: { total: { type: "integer" } }, type: "object" },
			},
			type: "object",
		} as SchemaObject
		expect(deriveCollectionShape(envelope)?.key).toBe("data")
	})
})
