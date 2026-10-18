import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Responder } from "../../checks/__fixtures__/harness.ts"
import {
	contextOf,
	entityRunOf,
	flow,
	notesApi,
	notesDoc,
	optionsFor,
	overriding,
	withLogin,
} from "../__fixtures__/api.ts"
import type { RunContext } from "../context.ts"
import type { RunOptions } from "../types.ts"
import { testEntity } from "./test-entity.ts"

/*
 * One entity, end to end: seeded, every principal scoped, its list's query resolved, its checks
 * run. An entity with no list is tested by its root read or as the caller, or not at all; one
 * whose seeding found nothing to test against stops there.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const thing = { properties: { id: { type: "string" } }, type: "object" }

/** A document of one operation tagged as `entity`. */
function tagged(
	path: string,
	method: string,
	entity: Record<string, string>,
	extra: Record<string, unknown> = {},
): OpenApiDocument {
	return {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			[path]: {
				[method]: {
					operationId: `${entity.name}.${entity.action}`,
					responses: { "200": { description: "ok", ...json(thing) } },
					"x-entity": entity,
					...extra,
				},
			},
		},
	} as unknown as OpenApiDocument
}

async function tested(
	respond: Responder,
	entity: string,
	extra: Partial<RunOptions> = {},
	before?: (ctx: RunContext) => void | Promise<void>,
) {
	const options = optionsFor(respond, extra)
	const ctx = await contextOf(options)
	await before?.(ctx)
	const model = ctx.model.entities.get(entity)
	if (model === undefined) throw new Error(`no ${entity} entity`)
	await testEntity(ctx, model)
	return { ctx, options }
}

const serving =
	(doc: OpenApiDocument, answer: unknown = { id: "x" }): Responder =>
	(_, path) =>
		path === "/openapi.json" ? { body: doc, status: 200 } : { body: answer, status: 200 }

describe("testEntity without a list", () => {
	it("tests a root by reading it", async () => {
		const doc = tagged(
			"/orgs/{org_id}",
			"get",
			{ action: "read", identity: "root", name: "org" },
			{
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
			},
		)
		const { ctx } = await tested(serving(doc), "org", { roots: { org_id: "o1" } })
		expect(ctx.state.entitiesTested).toEqual(["org"])
	})

	it("tests the caller by reading itself", async () => {
		const { ctx } = await tested(
			serving(tagged("/me", "get", { action: "read", identity: "self", name: "profile" })),
			"profile",
		)
		expect(ctx.state.entitiesTested).toEqual(["profile"])
	})

	it("tests nothing of an entity with neither", async () => {
		const doc = tagged(
			"/widgets",
			"post",
			{ action: "create", name: "widget" },
			{ requestBody: { required: true, ...json(thing) } },
		)
		const { ctx, options } = await tested(serving(doc), "widget")
		expect(ctx.state.entitiesTested).toEqual([])
		expect(options.seen.filter((request) => request.method === "POST")).toEqual([])
	})
})

describe("testEntity stops early", () => {
	it("when the network is gone for good", async () => {
		const { ctx } = await tested(notesApi(), "note", {}, (run) =>
			run.network.gate.awaitRecovery(Object.assign(new Error("x"), { kind: "dns" }) as never).then(() => undefined),
		)
		expect(ctx.state.entitiesTested).toEqual([])
	})

	it("when the profile excludes the list, which every check goes through", async () => {
		const { ctx } = await tested(notesApi(), "note", { profile: "p", profiles: { p: { exclude: ["notes.list"] } } })
		expect(ctx.state.entitiesTested).toEqual([])
		expect(ctx.findings.findings[0]).toMatchObject({ check: "profile.skip", operations: ["notes.list"] })
	})

	it("when the first principal's credential cannot be renewed", async () => {
		const state = { failing: false, issued: 0 }
		const login = withLogin(state)
		const { ctx } = await tested(login, "note", { principals: [flow] }, () => {
			state.failing = true
		})
		expect(ctx.findings.findings[0]).toMatchObject({ check: "auth.refresh", entity: "note" })
		expect(ctx.state.entitiesTested).toEqual([])
	})

	it("when seeding left nothing to test against", async () => {
		const owner = { covers: ["notes.create"], id: "own", steps: [{ operationId: "notes.create" }] }
		const { ctx } = await tested(notesApi(), "note", { scenarios: [owner] as never })
		expect(ctx.state.entitiesTested).toEqual([])
	})
})

describe("testEntity", () => {
	it("seeds the entity, says so, and runs its checks", async () => {
		const messages: string[] = []
		const { ctx } = await tested(notesApi(), "note", {
			onProgress: (snap) => messages.push(`${snap.phase} ${snap.message ?? ""}`),
		})
		expect(messages).toContain("seed seeding")
		expect(ctx.state.entitiesTested).toEqual(["note"])
		expect(ctx.state.checksRun.size).toBeGreaterThan(10)
		expect(ctx.state.takenByEntity.get("note")?.size).toBeGreaterThan(0)
	})

	it("attributes seeding findings to the create in a full run, and to the targets in a targeted one", async () => {
		const crashing = overriding(notesApi(), (method) => (method === "POST" ? { status: 500 } : undefined))
		const full = await tested(crashing, "note")
		expect(full.ctx.findings.findings[0]?.operations).toEqual(["notes.create"])
		const targeted = await contextOf(optionsFor(crashing, { ops: ["notes.get"] }))
		const run = entityRunOf(targeted)
		run.findings.gap("world.seed", "note", "s", "d")
		expect(targeted.findings.findings[0]?.operations).toEqual(["notes.get"])
	})

	it("attributes nothing for a listed entity with no create in a full run", async () => {
		const listOnly = structuredClone(notesDoc()) as unknown as { paths: Record<string, Record<string, unknown>> }
		delete listOnly.paths["/notes"]?.post
		const ctx = await contextOf(optionsFor(notesApi(listOnly as unknown as OpenApiDocument)))
		const run = entityRunOf(ctx)
		run.findings.gap("world.seed", "note", "s", "d")
		expect(ctx.findings.findings[0]).not.toHaveProperty("operations")
	})
})

describe("testEntity seed plans", () => {
	it("makes the parent first for a listed entity whose action declares effects, and not for one without", async () => {
		const listOnly = structuredClone(notesDoc()) as unknown as { paths: Record<string, Record<string, unknown>> }
		delete listOnly.paths["/notes"]?.post
		listOnly.paths["/notes/{note_id}/archive"] = {
			post: {
				operationId: "notes.archive",
				parameters: [{ in: "path", name: "note_id", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
				"x-effects": [{ entity: "note", op: "update" }],
			},
		}
		listOnly.paths["/notes/{note_id}/pin"] = {
			post: {
				operationId: "notes.pin",
				parameters: [{ in: "path", name: "note_id", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
			},
		}
		const doc = listOnly as unknown as OpenApiDocument
		const withEffects = await tested(notesApi(doc, [{ id: "n1", title: "a" }]), "note")
		expect(withEffects.ctx.state.entitiesTested).toEqual(["note"])
		const targetedAway = await tested(notesApi(doc, [{ id: "n1", title: "a" }]), "note", { ops: ["notes.pin"] })
		expect(targetedAway.ctx.state.entitiesTested).toEqual(["note"])
	})

	it("reads an invite-only entity as listed", async () => {
		const invited = structuredClone(notesDoc()) as unknown as {
			paths: Record<string, Record<string, Record<string, unknown>>>
		}
		delete invited.paths["/notes"]?.post
		const patch = invited.paths["/notes/{note_id}"]?.patch
		if (patch !== undefined) patch["x-invite"] = { accept: "notes.get", invite: "notes.update", revoke: "notes.delete" }
		const { ctx, options } = await tested(
			notesApi(invited as unknown as OpenApiDocument, [{ id: "n1", title: "a" }]),
			"note",
		)
		expect(ctx.state.entitiesTested).toEqual(["note"])
		expect(options.seen.filter((request) => request.method === "POST" && request.path === "/notes")).toEqual([])
	})

	it("does not seed through a create the principals' sign-up already sent", async () => {
		const signup = {
			...flow,
			auth: { credentialFrom: "$.token", steps: [{ body: { title: "me" }, operationId: "notes.create" }] },
		} as never
		const notes = notesApi()
		const respond: Responder = (method, path, request) =>
			method === "POST" && path === "/notes"
				? { body: { id: "u1", title: "me", token: "t-1" }, status: 201 }
				: notes(method, path, request)
		const { ctx } = await tested(respond, "note", { principals: [signup] })
		expect(ctx.state.entitiesTested).toEqual(["note"])
	})
})
