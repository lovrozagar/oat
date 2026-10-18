/** The document's `components`: its shared schemas and its security scheme. */

import { errorSchemas } from "./errors.ts"
import { itemSchema, schemaName } from "./schemas.ts"
import type { Json, SpecContext } from "./types.ts"

function componentSchemas(ctx: SpecContext): Json {
	const schemas = errorSchemas()
	schemas.Point = {
		additionalProperties: false,
		properties: { x: { type: "integer" }, y: { type: "integer" } },
		required: ["x", "y"],
		type: "object",
	}
	/* Recursive: a node's children are nodes. Real documents describe trees, comment threads and
	 * org charts this way, and nothing about it is unusual — except to a tool that inlines refs. */
	schemas.TreeNode = {
		properties: {
			children: { items: { $ref: "#/components/schemas/TreeNode" }, type: "array" },
			name: { type: "string" },
		},
		required: ["name"],
		type: "object",
	}
	if (ctx.shape.specLayout === true) {
		for (const entity of ctx.entities) schemas[schemaName(entity)] = itemSchema(entity)
	}
	return schemas
}

export function components(ctx: SpecContext): Json {
	return {
		schemas: componentSchemas(ctx),
		securitySchemes: { bearer: { bearerFormat: "JWT", scheme: "bearer", type: "http" } },
	}
}
