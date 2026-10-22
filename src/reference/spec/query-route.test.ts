import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { paymentSchemas, searchPaths } from "./query-route.ts"
import type { Json } from "./types.ts"

const CTX = { entities: ENTITIES, shape: {} }

const METHOD = {
	discriminator: {
		mapping: { bank: "#/components/schemas/Bank", card: "#/components/schemas/Card" },
		propertyName: "kind",
	},
	oneOf: [{ $ref: "#/components/schemas/Card" }, { $ref: "#/components/schemas/Bank" }],
}

describe("searchPaths", () => {
	it("declares a public QUERY whose body and answer are a card or a bank account, told apart by kind", () => {
		const search = (searchPaths(CTX) as Record<string, Record<string, Json>>)["/v1/search"]?.query
		expect(search).toMatchObject({ operationId: "search.query", security: [], tags: ["Search"] })
		expect(search?.requestBody).toEqual({ content: { "application/json": { schema: METHOD } }, required: true })
		expect(search).toHaveProperty(["responses", "200", "content", "application/json", "schema"], METHOD)
		expect(Object.keys(search?.responses as Json)).toEqual(["200", "400", "415"])
	})
})

describe("paymentSchemas", () => {
	it("declares each branch closed, with the tag and its own fields required", () => {
		const { Bank, Card } = paymentSchemas() as Record<string, Json>
		expect(Card).toEqual({
			additionalProperties: false,
			properties: {
				kind: { type: "string" },
				last4: { maxLength: 4, minLength: 4, pattern: "^[0-9]{4}$", type: "string" },
			},
			required: ["kind", "last4"],
			type: "object",
		})
		expect(Bank).toEqual({
			additionalProperties: false,
			properties: { account: { maxLength: 34, minLength: 1, type: "string" }, kind: { type: "string" } },
			required: ["kind", "account"],
			type: "object",
		})
	})
})
