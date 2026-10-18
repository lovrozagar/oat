import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model.ts"
import { errorResponses, errorSchemas } from "./errors.ts"

describe("errorResponses", () => {
	it("declares each requested status, keyed to its own schema", () => {
		const responses = errorResponses({ entities: ENTITIES, shape: {} }, [404, 400, 418])
		expect(Object.keys(responses)).toEqual(["400", "404"])
		expect(responses["404"]).toEqual({
			content: { "application/json": { schema: { $ref: "#/components/schemas/Err404" } } },
			description: "not_found",
		})
	})

	it("declares one default response under range statuses", () => {
		expect(errorResponses({ entities: ENTITIES, shape: { rangeStatuses: true } }, [400, 401])).toEqual({
			default: {
				content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
				description: "error",
			},
		})
	})
})

describe("errorSchemas", () => {
	it("declares one schema per status, then the catch-all Error", () => {
		const schemas = errorSchemas()
		expect(Object.keys(schemas)).toEqual(["Err400", "Err401", "Err403", "Err404", "Err409", "Err415", "Error"])
		expect(schemas.Err409).toMatchObject({
			properties: { error_key: { enum: ["conflict"] }, status: { enum: [409] }, success: { const: false } },
		})
		expect(schemas.Error).toMatchObject({ properties: { status: { type: "integer" } } })
	})
})
