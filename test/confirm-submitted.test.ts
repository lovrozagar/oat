import { describe, expect, it } from "vitest"
import type { Client, Exchange, RequestOptions } from "../src/runtime/client.ts"
import { confirmSubmitted } from "../src/runtime/world.ts"
import { buildModel, type OperationModel } from "../src/spec/graph.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * An id oat only sent proves nothing: the server may have ignored it. `confirmSubmitted` trusts it
 * only once the entity's read, under that id, returns that id with every scalar field oat sent.
 */

function spec(options: { withRead: boolean }): OpenApiDocument {
	const note = {
		properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } },
		required: ["id", "name"],
		type: "object",
	}
	const ok = { content: { "application/json": { schema: note } }, description: "ok" }
	return {
		info: { title: "confirm", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/projects/{projectId}/notes": {
				get: {
					operationId: "note.list",
					parameters: [{ in: "path", name: "projectId", required: true, schema: { type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: { items: note, type: "array" } } }, description: "ok" },
					},
				},
				post: {
					operationId: "note.create",
					parameters: [{ in: "path", name: "projectId", required: true, schema: { type: "string" } }],
					requestBody: { content: { "application/json": { schema: note } }, required: true },
					responses: { "200": { description: "acknowledged" } },
				},
			},
			"/projects/{projectId}/notes/{noteId}": {
				delete: {
					operationId: "note.delete",
					parameters: [
						{ in: "path", name: "projectId", required: true, schema: { type: "string" } },
						{ in: "path", name: "noteId", required: true, schema: { type: "string" } },
					],
					responses: { "204": { description: "gone" } },
				},
				...(options.withRead
					? {
							get: {
								operationId: "note.get",
								parameters: [
									{ in: "path", name: "projectId", required: true, schema: { type: "string" } },
									{ in: "path", name: "noteId", required: true, schema: { type: "string" } },
								],
								responses: { "200": ok, "404": { description: "missing" } },
							},
						}
					: {}),
			},
		},
	} as OpenApiDocument
}

function exchange(status: number, responseBody: unknown): Exchange {
	return {
		at: 0,
		durationMs: 0,
		method: "GET",
		requestBody: undefined,
		requestBytes: 0,
		requestHeaders: {},
		requestId: "",
		responseBody,
		responseBytes: 0,
		responseHeaders: {},
		seq: 0,
		status,
		url: "http://test.local",
	}
}

/* A client that answers every read with one exchange and remembers what it was asked. */
function reader(answer: Exchange): {
	client: Pick<Client, "get">
	reads: Array<{ path: string; options: RequestOptions }>
} {
	const reads: Array<{ path: string; options: RequestOptions }> = []
	return {
		client: {
			get: async (path: string, options: RequestOptions = {}) => {
				reads.push({ options, path })
				return answer
			},
		},
		reads,
	}
}

const scope = { projectId: "p1" }
const headers = { authorization: "Bearer alpha" }

function confirm(
	client: Pick<Client, "get">,
	sent: unknown,
	extra: { withRead?: boolean; ignore?: readonly string[]; readable?: (op: OperationModel) => boolean } = {},
): Promise<Record<string, unknown> | null> {
	return confirmSubmitted({
		client,
		entity: "note",
		headers,
		identity: "id",
		model: buildModel(spec({ withRead: extra.withRead ?? true })),
		scope,
		sent,
		...(extra.ignore === undefined ? {} : { ignore: extra.ignore }),
		...(extra.readable === undefined ? {} : { readable: extra.readable }),
	})
}

describe("confirmSubmitted", () => {
	it("returns the read record when it shows the sent id and every sent field", async () => {
		const stored = { createdAt: "2026-10-15", id: "n1", name: "first", size: 3 }
		const { client, reads } = reader(exchange(200, stored))
		expect(await confirm(client, { id: "n1", name: "first", size: 3 })).toEqual(stored)
		expect(reads).toEqual([{ options: { headers, operationId: "note.get" }, path: "/projects/p1/notes/n1" }])
	})

	it("refuses a read that shows another record's fields under that id", async () => {
		const { client } = reader(exchange(200, { id: "n1", name: "somebody else's", size: 3 }))
		expect(await confirm(client, { id: "n1", name: "first", size: 3 })).toBeNull()
	})

	it("refuses a read that answers with another id", async () => {
		const { client } = reader(exchange(200, { id: "n2", name: "first" }))
		expect(await confirm(client, { id: "n1", name: "first" })).toBeNull()
	})

	it("refuses when the read finds nothing", async () => {
		const { client } = reader(exchange(404, { error: "not found" }))
		expect(await confirm(client, { id: "n1", name: "first" })).toBeNull()
	})

	it("refuses, without reading, when the entity has no read", async () => {
		const { client, reads } = reader(exchange(200, { id: "n1", name: "first" }))
		expect(await confirm(client, { id: "n1", name: "first" }, { withRead: false })).toBeNull()
		expect(reads).toEqual([])
	})

	it("refuses, without reading, when the read may not be called", async () => {
		const { client, reads } = reader(exchange(200, { id: "n1", name: "first" }))
		expect(await confirm(client, { id: "n1", name: "first" }, { readable: () => false })).toBeNull()
		expect(reads).toEqual([])
	})

	it("refuses, without reading, a body that carries nothing but the id", async () => {
		const { client, reads } = reader(exchange(200, { id: "n1" }))
		expect(await confirm(client, { id: "n1" })).toBeNull()
		expect(reads).toEqual([])
	})

	it("refuses, without reading, a body that is not a plain object or has no scalar id", async () => {
		const { client, reads } = reader(exchange(200, { id: "n1", name: "first" }))
		expect(await confirm(client, [{ id: "n1", name: "first" }])).toBeNull()
		expect(await confirm(client, "id=n1&name=first")).toBeNull()
		expect(await confirm(client, { id: { value: "n1" }, name: "first" })).toBeNull()
		expect(await confirm(client, { name: "first" })).toBeNull()
		expect(reads).toEqual([])
	})

	it("leaves an ignored field out of the comparison", async () => {
		const stored = { id: "n1", name: "mangled\u0000", size: 3 }
		const { client } = reader(exchange(200, stored))
		expect(await confirm(client, { id: "n1", name: "sent\u0000", size: 3 }, { ignore: ["name"] })).toEqual(stored)
		expect(await confirm(client, { id: "n1", name: "sent\u0000", size: 3 })).toBeNull()
	})

	it("compares a numeric sent id with a string read id as strings", async () => {
		const stored = { id: "7", name: "first" }
		const { client } = reader(exchange(200, stored))
		expect(await confirm(client, { id: 7, name: "first" })).toEqual(stored)
	})
})
