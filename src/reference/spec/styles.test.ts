import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { stylePaths } from "./styles.ts"
import type { Json } from "./types.ts"

const CTX = { entities: ENTITIES, shape: {} }

describe("stylePaths", () => {
	it("declares a public read whose required query is a deepObject range and pipe-delimited ids", () => {
		const read = (stylePaths(CTX) as Record<string, Record<string, Json>>)["/v1/styles"]?.["get"]
		expect(read).toMatchObject({ operationId: "styles.read", security: [], tags: ["Styles"] })
		expect(read?.["parameters"]).toEqual([
			{
				example: { max: 5, min: 1 },
				in: "query",
				name: "range",
				required: true,
				schema: {
					additionalProperties: false,
					properties: { max: { type: "integer" }, min: { type: "integer" } },
					required: ["min", "max"],
					type: "object",
				},
				style: "deepObject",
			},
			{
				example: ["a", "b"],
				explode: false,
				in: "query",
				name: "ids",
				required: true,
				schema: { items: { pattern: "^[a-z0-9_]+$", type: "string" }, minItems: 1, type: "array" },
				style: "pipeDelimited",
			},
		])
		expect(Object.keys(read?.["responses"] as Json)).toEqual(["200", "400"])
	})
})
