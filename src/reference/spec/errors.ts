/** The failures a document declares: one schema per error status, and the responses that use them. */

import type { Json, SpecContext } from "./types.ts"

function errorSchema(status: number, key: string): Json {
	return {
		additionalProperties: false,
		properties: {
			error_key: { enum: [key], type: "string" },
			message: { type: "string" },
			status: { enum: [status], type: "integer" },
			success: { const: false },
		},
		required: ["error_key", "message", "status", "success"],
		type: "object",
	}
}

const ERRORS: Array<[number, string]> = [
	[400, "invalid_input"],
	[401, "unauthorized"],
	[403, "forbidden"],
	[404, "not_found"],
	[409, "conflict"],
	[415, "unsupported_media_type"],
]

export function errorResponses(ctx: SpecContext, codes: number[]): Json {
	/* A document may describe every failure at once: one `default` response and one schema. */
	if (ctx.shape.rangeStatuses === true) {
		return {
			default: {
				content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
				description: "error",
			},
		}
	}
	const out: Json = {}
	for (const [status, key] of ERRORS) {
		if (!codes.includes(status)) continue
		out[String(status)] = {
			content: { "application/json": { schema: { $ref: `#/components/schemas/Err${status}` } } },
			description: key,
		}
	}
	return out
}

/** The component schemas the error responses refer to: one per status, and the catch-all `Error`. */
export function errorSchemas(): Json {
	const schemas: Json = {}
	for (const [status, key] of ERRORS) schemas[`Err${status}`] = errorSchema(status, key)
	schemas.Error = {
		additionalProperties: false,
		properties: {
			error_key: { type: "string" },
			message: { type: "string" },
			status: { type: "integer" },
			success: { const: false },
		},
		required: ["error_key", "message", "status", "success"],
		type: "object",
	}
	return schemas
}
