import type { OpenApiDocument } from "../../src/spec/types.ts"

/* The batch API behind the SSE tests: a stream that names a batch, optionally polled by x-async. */

export const COMPLETE_STREAM =
	'event: batch\ndata: {"batch_id":"b_1"}\n\nevent: complete\ndata: {"status":"complete"}\n\n'
export const BATCH_ONLY_STREAM = 'event: batch\ndata: {"batch_id":"b_1"}\n\n'

export const SSE_ASYNC = {
	idFrom: "$.batch_id",
	poll: "GET /v1/batches/{batch_id}",
	pollIntervalMs: 1,
	successWhen: "status.eq.complete",
	timeoutMs: 1_000,
	until: "status.eq.complete",
} as const

export function itemSchema(): Record<string, unknown> {
	return {
		properties: { id: { type: "string" }, name: { type: "string" } },
		required: ["id", "name"],
		type: "object",
	}
}

function streamOperation(async: boolean): Record<string, unknown> {
	const stream: Record<string, unknown> = {
		operationId: "extract.stream",
		requestBody: {
			content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
		},
		responses: {
			"200": {
				content: { "text/event-stream": { schema: { type: "string" } } },
				description: "stream",
			},
		},
		"x-effects": [{ entity: "batch", op: "update" }],
		"x-entity": { action: "action", identity: "id", name: "batch" },
	}
	if (async) stream["x-async"] = { ...SSE_ASYNC }
	return stream
}

function batchCollection(): Record<string, unknown> {
	return {
		get: {
			operationId: "batch.list",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: {
								properties: { batches: { items: itemSchema(), type: "array" } },
								required: ["batches"],
								type: "object",
							},
						},
					},
					description: "ok",
				},
			},
			"x-entity": { action: "list", identity: "id", name: "batch" },
		},
		post: {
			operationId: "batch.create",
			requestBody: {
				content: {
					"application/json": {
						schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
					},
				},
				required: true,
			},
			responses: {
				"201": { content: { "application/json": { schema: itemSchema() } }, description: "created" },
			},
			"x-entity": { action: "create", identity: "id", name: "batch" },
		},
	}
}

export function streamSpec(opts: { async: boolean }): OpenApiDocument {
	return {
		info: { title: "sse", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/batches": batchCollection(),
			"/v1/batches/{batch_id}": {
				get: {
					operationId: "batch.read",
					parameters: [{ in: "path", name: "batch_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: itemSchema() } }, description: "ok" },
					},
					"x-entity": { action: "read", identity: "id", name: "batch" },
				},
			},
			"/v1/extract/stream": { post: streamOperation(opts.async) },
		},
	} as OpenApiDocument
}
