import { describe, expect, it } from "vitest"
import { Client } from "../src/runtime/client.ts"
import { resolvePathScope, SeedError } from "../src/runtime/world.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

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
		const client = new Client("http://127.0.0.1:9")
		const refused = await resolvePathScope(create!, model, client, OPTIONS).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(SeedError)
		expect((refused as Error).message).toBe(
			'{thing_id} names the "thing" thing.create makes, so oat cannot seed it; supply it as a root or create it in a scenario',
		)
		expect(client.transcript).toEqual([])
	})
})
