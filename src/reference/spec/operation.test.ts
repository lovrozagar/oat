import { describe, expect, it } from "vitest"
import { LINKED, POSTGREST } from "../dialect.ts"
import { ENTITIES, ROW, TABLE } from "../model.ts"
import { declaredIdentity, entityTag, jsonResponse, listResponseHeaders, ok } from "./operation.ts"

describe("ok", () => {
	it("spells a success status exactly, or as the 2XX range", () => {
		expect(ok({ entities: ENTITIES, shape: {} }, 201)).toBe("201")
		expect(ok({ entities: ENTITIES, shape: { rangeStatuses: true } }, 201)).toBe("2XX")
	})
})

describe("jsonResponse", () => {
	it("carries a JSON schema, and headers only when given", () => {
		expect(jsonResponse("one", { type: "object" })).toEqual({
			content: { "application/json": { schema: { type: "object" } } },
			description: "one",
		})
		expect(jsonResponse("one", {}, { Link: {} }).headers).toEqual({ Link: {} })
	})
})

describe("listResponseHeaders", () => {
	it("declares Link pagination only for a dialect without an envelope", () => {
		expect(listResponseHeaders(LINKED)).toHaveProperty("Link.schema", { type: "string" })
		expect(listResponseHeaders(POSTGREST)).toBeUndefined()
	})
})

describe("declaredIdentity", () => {
	it("is the table's slug under the slug key, and the entity's identity otherwise", () => {
		const slugged = { entities: ENTITIES, shape: { tableKey: "slug" as const } }
		expect(declaredIdentity(slugged, TABLE)).toBe("slug")
		expect(declaredIdentity(slugged, ROW)).toBe("id")
		expect(declaredIdentity({ entities: ENTITIES, shape: {} }, TABLE)).toBe("id")
	})
})

describe("entityTag", () => {
	it("is the entity's name, capitalised", () => {
		expect(entityTag(ROW)).toBe("Row")
	})
})
