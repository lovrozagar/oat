import { describe, expect, it } from "vitest"
import { Client } from "../client/client.ts"
import type { RequestOptions } from "../client/types.ts"
import type { Exchange } from "./exchange.ts"
import {
	confirmSubmitted,
	idOf,
	isPlanLimitResponse,
	recordsFromList,
	resolvePathScope,
	SeedError,
	seedCohort,
} from "./world.ts"
import { buildModel } from "../spec/graph/build.ts"
import type { OperationModel } from "../spec/graph/types.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { dereference } from "../spec/load/dereference.ts"
import { Redactor } from "../security/redact.ts"
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

/*
 * A create whose own path names the record it makes — `PUT /projects/{project_id}/things/{thing_id}`
 * — cannot be seeded by making a parent first: the parameter's owner is the record itself, and
 * resolving it means resolving the same create again, without end. Seeding refuses it, naming the
 * parameter and what supplies it instead.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ITEM = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
const ok = { "200": { ...json(ITEM), description: "ok" } }
const PATH = [
	{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
	{ in: "path", name: "thing_id", required: true, schema: { type: "string" } },
]

const DOCUMENT = {
	info: { title: "own-create-path", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/projects/{project_id}/things": {
			get: {
				operationId: "thing.list",
				parameters: PATH.slice(0, 1),
				responses: { "200": { ...json({ items: ITEM, type: "array" }), description: "ok" } },
				"x-entity": { action: "list", name: "thing" },
			},
		},
		"/projects/{project_id}/things/{thing_id}": {
			get: {
				operationId: "thing.read",
				parameters: PATH,
				responses: ok,
				"x-entity": { action: "read", name: "thing" },
			},
			put: {
				operationId: "thing.create",
				parameters: PATH,
				requestBody: { ...json({ properties: { name: { type: "string" } }, type: "object" }), required: true },
				responses: { "201": { ...json(ITEM), description: "created" } },
				"x-entity": { action: "create", name: "thing" },
			},
		},
	},
} as unknown as OpenApiDocument

const OPTIONS = { authHeaders: () => ({}), roots: { project_id: "a" }, seed: 1 }

describe("seeding a create whose path names its own record", () => {
	it("is refused with the parameter and its remedy, not resolved through itself", async () => {
		const model = buildModel(dereference(DOCUMENT).doc)
		const create = model.byOperationId.get("thing.create")
		expect(create).toBeDefined()
		/* Nothing is sent: the refusal comes before any request. */
		const client = new Client({ baseUrl: "http://127.0.0.1:9", redactor: new Redactor() })
		const refused = await resolvePathScope(create!, model, client, OPTIONS).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(SeedError)
		expect((refused as Error).message).toBe(
			'{thing_id} names the "thing" thing.create makes, so oat cannot seed it; supply it as a root or create it in a scenario',
		)
		expect(client.transcript).toEqual([])
	})
})

describe("reading what a backend answered", () => {
	it("knows a plan-limit refusal by status or by a named error", () => {
		expect(isPlanLimitResponse(402, null)).toBe(true)
		expect(isPlanLimitResponse(403, { error: "payment_required" })).toBe(true)
		expect(isPlanLimitResponse(403, { error: "forbidden" })).toBe(false)
		expect(isPlanLimitResponse(429, { error: "payment_required" })).toBe(false)
		expect(isPlanLimitResponse(200, null)).toBe(false)
	})

	it("reads a list's rows from a bare array or under its collection key", () => {
		expect(recordsFromList([{ id: 1 }], null)).toEqual([{ id: 1 }])
		expect(recordsFromList({ items: [{ id: 2 }] }, "items")).toEqual([{ id: 2 }])
		expect(recordsFromList({ items: "x" }, "items")).toEqual([])
	})

	it("reads an identity only when the record has one", () => {
		expect(idOf({ id: 7 }, "id")).toBe("7")
		expect(idOf({ name: "x" }, "id")).toBeUndefined()
		expect(idOf(undefined, "id")).toBeUndefined()
	})
})

describe("seeding under a plan limit", () => {
	it("adopts a listed record instead of inventing one", async () => {
		const model = buildModel(spec({ withRead: true }))
		const createOp = model.byOperationId.get("note.create") as OperationModel
		const sent: string[] = []
		const client = {
			get: async (path: string) => {
				sent.push(`GET ${path}`)
				return exchange(200, [{ id: 7 }, { id: "n1", name: "kept" }])
			},
			request: async (method: string, path: string) => {
				sent.push(`${method} ${path}`)
				return exchange(402, { error: "payment_required" })
			},
		} as unknown as Client
		const seeded = await seedCohort(
			createOp,
			model,
			client,
			{ authHeaders: () => headers, roots: scope, seed: 1 },
			{ created: [], values: scope },
		)
		expect(seeded.adopted).toBe(true)
		expect(seeded.records).toEqual([{ id: 7 }])
		expect(sent).toContain("POST /projects/p1/notes")
		expect(sent).toContain("GET /projects/p1/notes")
	})
})

describe("seeding with a client-chosen identity another tenant holds", () => {
	it("draws the identity again and keeps the record the second create made", async () => {
		const model = buildModel(spec({ withRead: true }))
		const createOp = model.byOperationId.get("note.create") as OperationModel
		const sent: unknown[] = []
		const client = {
			get: async () => exchange(200, []),
			request: async (_method: string, _path: string, options: RequestOptions) => {
				const raw = options.body
				const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
				sent.push(body.id)
				return sent.length === 1 ? exchange(409, { error: "taken" }) : exchange(200, body)
			},
		} as unknown as Client
		const seeded = await seedCohort(
			createOp,
			model,
			client,
			{ authHeaders: () => headers, cohortSize: 1, roots: scope, seed: 1 },
			{ created: [], values: scope },
		)
		expect(sent).toHaveLength(2)
		expect(sent[1]).not.toEqual(sent[0])
		expect(seeded.records.map((record) => record.id)).toEqual([sent[1]])
	})
})
