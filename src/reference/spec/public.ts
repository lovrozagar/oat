/** Routes with no record to write: a read-only list of notices, and a public health read. */

import { errorResponses } from "./errors.ts"
import { jsonResponse, ok } from "./operation.ts"
import type { Json, SpecContext } from "./types.ts"

/** A list with no create. The row is already there. */
export function noticePaths(ctx: SpecContext): Json {
	const article = {
		additionalProperties: false,
		properties: { id: { type: "string" }, title: { type: "string" } },
		required: ["id", "title"],
		type: "object",
	}
	return {
		"/v1/notices": {
			get: {
				operationId: "notice.list",
				responses: {
					[ok(ctx, 200)]: jsonResponse("Notices", {
						additionalProperties: false,
						properties: { notices: { items: article, type: "array" } },
						required: ["notices"],
						type: "object",
					}),
				},
				summary: "List notices",
				tags: ["Notices"],
				"x-entity": { action: "list", identity: "id", name: "notice" },
			},
		},
		"/v1/notices/{id}": {
			get: {
				operationId: "notice.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: {
					[ok(ctx, 200)]: jsonResponse("One notice", article),
					...errorResponses(ctx, [404]),
				},
				summary: "Get notice",
				tags: ["Notices"],
				"x-entity": { action: "read", identity: "id", name: "notice" },
			},
		},
	}
}

/** A public read. No token, no id, no body. */
export function publicReadPaths(ctx: SpecContext): Json {
	return {
		"/health": {
			get: {
				operationId: "gateway.health",
				responses: {
					[ok(ctx, 200)]: jsonResponse("The service is up", {
						additionalProperties: false,
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
						type: "object",
					}),
				},
				security: [],
				summary: "Health",
				tags: ["Gateway"],
			},
		},
	}
}
