import { describe, expect, it } from "vitest"
import { type Responder, fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { SeedError } from "../seed-error.ts"
import { COUNTERS, json, TENANT, tables } from "./__fixtures__/documents.ts"
import { resolvePathScope } from "./path-scope.ts"
import type { AncestorCache, WorldOptions } from "./types.ts"

const tableMade: Responder = (method, path) =>
	method === "POST" && path === "/projects/p1/tables" ? { body: { id: "t1", name: "x" }, status: 201 } : undefined

function world(respond: Responder, options: Partial<WorldOptions> = {}, document = tables()) {
	const model = modelOf(document)
	const fake = fakeClient(respond)
	const created: string[] = []
	return {
		created,
		model,
		seeding: {
			client: fake.client,
			model,
			options: {
				principal: "alpha",
				onCreate: (entity: string, id: string) => created.push(`${entity} ${id}`),
				roots: { project_id: "p1" },
				seed: 1,
				...options,
			},
		},
		sent: fake.sent,
	}
}

const cache = (): AncestorCache => ({ creating: new Map(), made: new Map() })

describe("resolvePathScope", () => {
	it("takes roots and values already in scope, creating nothing", async () => {
		const run = world(tableMade)
		const scope = await resolvePathScope(op(run.model, "row.create"), run.seeding, {
			created: [],
			values: { table_id: "t0" },
		})
		expect(scope).toEqual({ created: [], values: { project_id: "p1", table_id: "t0" } })
		expect(run.sent).toEqual([])
	})

	it("creates the parent a path names, records it, and unwinds it in order", async () => {
		const run = world(tableMade)
		const scope = await resolvePathScope(op(run.model, "row.create"), run.seeding)
		expect(scope).toEqual({
			created: [{ entity: "table", id: "t1", path: "/projects/p1/tables" }],
			values: { project_id: "p1", table_id: "t1" },
		})
		expect(run.created).toEqual(["table t1"])
	})

	it("shares one parent per principal and parent path through the cache", async () => {
		const ancestors = cache()
		const run = world(tableMade, { ancestors, principal: "alpha" })
		const [first, second] = await Promise.all([
			resolvePathScope(op(run.model, "row.create"), run.seeding),
			resolvePathScope(op(run.model, "row.create"), run.seeding),
		])
		const again = await resolvePathScope(op(run.model, "row.create"), run.seeding)
		expect([first.values["table_id"], second.values["table_id"], again.values["table_id"]]).toEqual(["t1", "t1", "t1"])
		expect(run.sent.filter((request) => request.method === "POST")).toHaveLength(1)
		expect(ancestors.made.get("alpha\u0000table.create\u0000/projects/p1/tables")).toBe("t1")
		expect(ancestors.creating.size).toBe(0)
	})

	it("forgets a create in flight that failed, so the next resolve tries again", async () => {
		const ancestors = cache()
		const run = world(() => ({ body: { error: "down" }, status: 503 }), { ancestors })
		await expect(resolvePathScope(op(run.model, "row.create"), run.seeding)).rejects.toThrow(SeedError)
		expect(ancestors.creating.size).toBe(0)
		expect(ancestors.made.size).toBe(0)
	})
})

describe("resolvePathScope, refused or adopted", () => {
	it("does not report an adopted parent as its own", async () => {
		const run = world((method) =>
			method === "POST" ? { body: { error: "payment_required" }, status: 402 } : { body: [{ id: "t5" }], status: 200 },
		)
		const scope = await resolvePathScope(op(run.model, "row.create"), run.seeding)
		expect(scope.values["table_id"]).toBe("t5")
		expect(run.created).toEqual([])
	})

	it("reads a parent with no identity of its own by id", async () => {
		const run = world(
			(method) => (method === "POST" ? { body: { id: "c1", size: 1 }, status: 201 } : undefined),
			{},
			COUNTERS,
		)
		const scope = await resolvePathScope(op(run.model, "tick.create"), run.seeding)
		expect(scope.values).toEqual({ counter_id: "c1" })
	})

	it("refuses a parent whose create names no id oat can use", async () => {
		const run = world(() => ({ body: { ok: true }, status: 201 }))
		await expect(resolvePathScope(op(run.model, "row.create"), run.seeding)).rejects.toThrow(
			'create for "table" returned no usable "id"',
		)
	})

	it("refuses a parameter no entity owns, or whose owner has no create", async () => {
		const unowned = world(tableMade, { roots: {} }, TENANT)
		await expect(resolvePathScope(op(unowned.model, "note.create"), unowned.seeding)).rejects.toThrow(
			"path parameter {tenant} names no entity oat can create",
		)
		const uncreatable = world(tableMade, {}, tables(null))
		await expect(resolvePathScope(op(uncreatable.model, "row.create"), uncreatable.seeding)).rejects.toThrow(
			'{table_id} identifies a "table", which has no create operation — supply it as a root',
		)
	})
})

/*
 * A create whose own path names the record it makes — `PUT /projects/{project_id}/things/{thing_id}`
 * — cannot be seeded by making a parent first: the parameter's owner is the record itself, and
 * resolving it means resolving the same create again, without end. Seeding refuses it, naming the
 * parameter and what supplies it instead.
 */

const ITEM = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
const PATH = [
	{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
	{ in: "path", name: "thing_id", required: true, schema: { type: "string" } },
]

const OWN_PATH = {
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
				responses: { "200": { ...json(ITEM), description: "ok" } },
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

describe("seeding a create whose path names its own record", () => {
	it("is refused with the parameter and its remedy, not resolved through itself", async () => {
		const run = world(() => ({ status: 201 }), { roots: { project_id: "a" } }, OWN_PATH)
		const refused = await resolvePathScope(op(run.model, "thing.create"), run.seeding).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(SeedError)
		expect((refused as Error).message).toBe(
			'{thing_id} names the "thing" thing.create makes, so oat cannot seed it; supply it as a root or create it in a scenario',
		)
		/* Nothing is sent: the refusal comes before any request. */
		expect(run.sent).toEqual([])
	})
})
