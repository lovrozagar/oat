import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Responder } from "../../checks/__fixtures__/harness.ts"
import type { Record_ } from "../../world.ts"
import { contextOf, entityRunOf, notesApi, notesDoc, optionsFor } from "../__fixtures__/api.ts"
import type { RunOptions } from "../types.ts"
import { seedWorld } from "./seed.ts"

/*
 * How an entity's records come to exist: a create oat may send seeds them; a create a scenario
 * owns, a profile excludes, or that sign-up already ran leaves the entity read as listed; a list
 * under a parent gets the parent made first.
 */

const SEEDS = { authProvisioned: false, inviteOnly: false, needsListedCohort: false }

const card = { properties: { id: { type: "string" }, text: { type: "string" } }, type: "object" }
const board = {
	properties: { id: { readOnly: true, type: "string" }, name: { type: "string" } },
	required: ["name"],
	type: "object",
}
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const boardId = { in: "path", name: "board_id", required: true, schema: { type: "string" } }

/** Boards oat can make (or not), and cards listed under a board, with no create of their own. */
function boardsDoc(boardsCreate: boolean): OpenApiDocument {
	return {
		info: { title: "boards", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/boards": {
				get: {
					operationId: "boards.list",
					responses: { "200": { description: "ok", ...json({ items: board, type: "array" }) } },
				},
				...(boardsCreate
					? {
							post: {
								operationId: "boards.create",
								requestBody: { required: true, ...json(board) },
								responses: { "201": { description: "made", ...json(board) } },
							},
						}
					: {}),
			},
			"/boards/{board_id}/cards": {
				get: {
					operationId: "cards.list",
					parameters: [boardId],
					responses: { "200": { description: "ok", ...json({ items: card, type: "array" }) } },
				},
			},
		},
	} as unknown as OpenApiDocument
}

/** Boards made on request as b1, b2, …; cards c1 under any board. */
function boardsApi(doc: OpenApiDocument): Responder {
	let made = 0
	return (method, path) => {
		if (path === "/openapi.json") return { body: doc, status: 200 }
		if (path === "/boards" && method === "POST") {
			made += 1
			return { body: { id: `b${made}`, name: `b${made}` }, status: 201 }
		}
		if (path === "/boards") return { body: [], status: 200 }
		if (/^\/boards\/[^/]+\/cards$/.test(path)) return { body: [{ id: "c1", text: "t" }], status: 200 }
		return undefined
	}
}

/** Boards whose create breaks the transport itself. */
const brokenBoards: Responder = (method, path, request) => {
	if (path === "/boards" && method === "POST") throw new Error("transport broke")
	return boardsApi(boardsDoc(true))(method, path, request)
}

async function runFor(respond: Responder, entity: string, extra: Partial<RunOptions> = {}) {
	const options = optionsFor(respond, extra)
	const ctx = await contextOf(options)
	return { ctx, options, run: entityRunOf(ctx, entity) }
}

describe("seedWorld when a scenario owns the create", () => {
	const owner = { covers: ["notes.create"], id: "own", steps: [{ operationId: "notes.create" }] } as never

	it("reads what exists rather than send a body the scenario's create would refuse", async () => {
		const rows: Record_[] = [{ id: "n1", title: "a" }]
		const { run, options } = await runFor(notesApi(notesDoc(), rows), "note", { scenarios: [owner] })
		expect(await seedWorld(run, SEEDS)).toMatchObject({ degraded: true, records: rows })
		expect(options.seen.some((request) => request.method === "POST")).toBe(false)
	})

	it("leaves the entity to the scenario when nothing exists", async () => {
		const { run } = await runFor(notesApi(), "note", { scenarios: [owner] })
		expect(await seedWorld(run, SEEDS)).toBeNull()
	})
})

describe("seedWorld when the profile excludes the create", () => {
	const profile = { profile: "safe", profiles: { safe: { exclude: ["notes.create"] } } }

	it("reads what exists", async () => {
		const { run } = await runFor(notesApi(notesDoc(), [{ id: "n1", title: "a" }]), "note", profile)
		expect(await seedWorld(run, SEEDS)).toMatchObject({ degraded: true, records: [{ id: "n1" }] })
	})

	it("blocks the entity when nothing exists", async () => {
		const { run, ctx } = await runFor(notesApi(), "note", profile)
		expect(await seedWorld(run, SEEDS)).toBeNull()
		expect(ctx.findings.findings.at(-1)).toMatchObject({
			check: "profile.skip",
			summary: 'could not test "note"',
			verdict: "BLOCKED",
		})
	})
})

describe("seedWorld for an entity read as listed", () => {
	it("makes the parent its list path names, and reads the list under it", async () => {
		const { run, options } = await runFor(boardsApi(boardsDoc(true)), "card")
		const world = await seedWorld(run, SEEDS)
		expect(world).toMatchObject({ degraded: true, records: [{ id: "c1" }], scope: { values: { board_id: "b1" } } })
		expect(options.seen.map((request) => `${request.method} ${request.path}`)).toContain("GET /boards/b1/cards")
	})

	it("makes the parent first for an entity whose action declares effects", async () => {
		const { run } = await runFor(boardsApi(boardsDoc(true)), "card")
		expect(await seedWorld(run, { ...SEEDS, needsListedCohort: true })).toMatchObject({
			scope: { values: { board_id: "b1" } },
		})
	})

	it("reads with the roots as they are when the parent cannot be made", async () => {
		const { run, options } = await runFor(boardsApi(boardsDoc(false)), "card")
		expect(await seedWorld(run, SEEDS)).toMatchObject({ degraded: true, records: [] })
		expect(options.seen.some((request) => request.path.includes("/cards"))).toBe(false)
	})

	it("needs no parent when the roots name it, or for an invite-only entity", async () => {
		const given = await runFor(boardsApi(boardsDoc(true)), "card", { roots: { board_id: "given" } })
		expect(await seedWorld(given.run, SEEDS)).toMatchObject({ scope: { values: { board_id: "given" } } })
		const invited = await runFor(boardsApi(boardsDoc(true)), "card")
		expect(await seedWorld(invited.run, { ...SEEDS, inviteOnly: true })).toMatchObject({ records: [] })
		expect(invited.options.seen.some((request) => request.method === "POST")).toBe(false)
	})

	it("reads as listed when the create is sign-up, which already ran", async () => {
		const { run, options } = await runFor(notesApi(notesDoc(), [{ id: "n1", title: "a" }]), "note")
		expect(await seedWorld(run, { ...SEEDS, authProvisioned: true })).toMatchObject({
			degraded: true,
			records: [{ id: "n1" }],
		})
		expect(options.seen.some((request) => request.method === "POST")).toBe(false)
	})

	it("passes on an error that is not a parent oat could not make", async () => {
		const { run } = await runFor(brokenBoards, "card")
		await expect(seedWorld(run, SEEDS)).rejects.toThrow()
	})
})

describe("seedWorld with a create oat may send", () => {
	it("seeds a cohort through it", async () => {
		const rows: Record_[] = []
		const { run } = await runFor(notesApi(notesDoc(), rows), "note")
		const world = await seedWorld(run, SEEDS)
		expect(world).toMatchObject({ degraded: false })
		expect(world?.records.length).toBeGreaterThan(0)
	})
})
