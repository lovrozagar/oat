import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { EXIT, exitCode } from "../../src/runtime/exit.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { JsonSchema, OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A create oat cannot read an id from leaves a record oat cannot remove. Behind a records API
 * whose identity is an upper-case integer `ID` and whose create answers an envelope
 * `{ success, id, message, data: { ID, ... } }`, records made by checks went unrecorded and stayed
 * behind with nobody told. Every create's id is resolved, or the create is reported as a leftover
 * and fails the run. A related record nested in the answer (`Status: { ID, Name }`) carries an id
 * too: it never names the record that was made, so it never enters the delete list unconfirmed.
 */

type Mode =
	/* `{ success, id, message, data: { ID, ... } }` */
	| "envelope"
	/* the top-level `ID` names something else; `x-entity.createdIdFrom: $.data.ID` says where the id is */
	| "decoy"
	/* no id anywhere but the nested related record's */
	| "nested-only"
	/* `{ success: true }` and nothing else */
	| "ack"

/* The related record's id, apart from any note's, so a delete by it is unmistakably a guess. */
const STATUS_ID = 500
const STATUS = { properties: { ID: { type: "integer" }, Name: { type: "string" } }, type: "object" }
const ITEM = {
	properties: {
		ID: { readOnly: true, type: "integer" },
		Status: { ...STATUS, readOnly: true },
		name: { type: "string" },
		note: { type: "string" },
	},
	required: ["ID", "name"],
	type: "object",
}
const WRITE = { properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"], type: "object" }
const ID_PARAM = [{ in: "path", name: "ID", required: true, schema: { type: "integer" } }]
const REFUSED = { default: { description: "refused" } }

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })

const entityTag = (action: string, extra: Record<string, unknown> = {}) => ({
	"x-entity": { action, identity: "ID", name: "note", ...extra },
})

function createdSchema(mode: Mode): JsonSchema {
	if (mode === "ack") return { properties: { success: { type: "boolean" } }, type: "object" }
	return {
		properties: {
			ID: { type: "integer" },
			data: mode === "nested-only" ? { ...ITEM, required: ["name"] } : ITEM,
			id: { type: "integer" },
			message: { type: "string" },
			success: { type: "boolean" },
		},
		type: "object",
	}
}

function spec(mode: Mode): OpenApiDocument {
	const created = createdSchema(mode)
	return {
		info: { title: "created-id", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": {
							...json({ properties: { items: { items: ITEM, type: "array" } }, type: "object" }),
							description: "ok",
						},
						...REFUSED,
					},
					...entityTag("list"),
				},
				post: {
					operationId: "note.create",
					requestBody: { ...json(WRITE), required: true },
					responses: { "201": { ...json(created), description: "created" }, ...REFUSED },
					...entityTag("create", mode === "decoy" ? { createdIdFrom: "$.data.ID" } : {}),
				},
			},
			"/v1/notes/{ID}": {
				delete: {
					operationId: "note.delete",
					parameters: ID_PARAM,
					responses: { "204": { description: "gone" }, ...REFUSED },
					...entityTag("delete"),
				},
				get: {
					operationId: "note.read",
					parameters: ID_PARAM,
					responses: { "200": { ...json(ITEM), description: "ok" }, ...REFUSED },
					...entityTag("read"),
				},
				patch: {
					operationId: "note.update",
					parameters: ID_PARAM,
					requestBody: { ...json({ ...WRITE, required: [] }), required: true },
					responses: { "200": { ...json(ITEM), description: "ok" }, ...REFUSED },
					...entityTag("update"),
				},
			},
		},
	} as unknown as OpenApiDocument
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
	res.end(body === undefined ? "" : JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
				resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null)
			} catch {
				resolve(null)
			}
		})
	})
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((close) => close()))
})

type Store = Map<number, Record<string, unknown>>
type World = { deleted: string[]; mode: Mode; seq: number; store: Store }

/* What each mode's create answers for the row it just stored. */
function createdAnswer(mode: Mode, row: Record<string, unknown> & { ID: number }, seq: number): unknown {
	if (mode === "ack") return { success: true }
	const { ID: _id, ...withoutId } = row
	if (mode === "nested-only") return { data: withoutId, message: "created", success: true }
	const answer = { data: row, id: row.ID, message: "created", success: true }
	return mode === "decoy" ? { ...answer, ID: 9000 + seq, id: 9000 + seq } : answer
}

async function createNote(world: World, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await readJson(req)
	if (body === null || typeof body["name"] !== "string") return send(res, 400, { error: "name is required" })
	if (body["note"] !== undefined && typeof body["note"] !== "string") return send(res, 400, { error: "note is text" })
	world.seq += 1
	const row = {
		ID: world.seq,
		Status: { ID: STATUS_ID, Name: "open" },
		name: body["name"],
		note: String(body["note"] ?? ""),
	}
	world.store.set(row.ID, row)
	send(res, 201, createdAnswer(world.mode, row, world.seq))
}

/* One request and the response that answers it. */
interface Exchange {
	req: IncomingMessage
	res: ServerResponse
}

async function patchNote(world: World, id: number, { req, res }: Exchange): Promise<void> {
	const row = world.store.get(id)
	if (row === undefined) return send(res, 404, {})
	const body = await readJson(req)
	if (body === null) return send(res, 400, { error: "json" })
	if (body["name"] !== undefined && typeof body["name"] !== "string") return send(res, 400, { error: "name is text" })
	if (body["note"] !== undefined && typeof body["note"] !== "string") return send(res, 400, { error: "note is text" })
	const next = {
		...row,
		...(body["name"] === undefined ? {} : { name: body["name"] }),
		...(body["note"] === undefined ? {} : { note: body["note"] }),
	}
	world.store.set(id, next)
	send(res, 200, next)
}

async function noteItem(world: World, raw: string | undefined, { req, res }: Exchange): Promise<void> {
	const method = req.method ?? "GET"
	const id = Number(raw)
	if (!Number.isInteger(id)) return send(res, 400, { error: "ID is an integer" })
	if (method === "GET") {
		const row = world.store.get(id)
		return row === undefined ? send(res, 404, {}) : send(res, 200, row)
	}
	if (method === "PATCH") return patchNote(world, id, { req, res })
	if (method !== "DELETE") return send(res, 405)
	world.deleted.push(raw ?? "")
	return world.store.delete(id) ? send(res, 204) : send(res, 404, {})
}

async function route(world: World, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const at = new URL(req.url ?? "/", "http://x")
	const method = req.method ?? "GET"
	if (at.pathname === "/v1/openapi/spec") return send(res, 200, spec(world.mode))
	const match = /^\/v1\/notes(?:\/([^/]+))?$/.exec(at.pathname)
	if (match === null) return send(res, 404, { error: "missing" })
	const raw = match[1] === undefined ? undefined : decodeURIComponent(match[1])
	if (raw === undefined && method === "GET") return send(res, 200, { items: [...world.store.values()] })
	if (raw === undefined && method === "POST") return createNote(world, req, res)
	return noteItem(world, raw, { req, res })
}

async function serve(mode: Mode) {
	const world: World = { deleted: [], mode, seq: 0, store: new Map() }
	const server = createServer((req, res) => {
		void route(world, req, res)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	servers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return {
		deleted: world.deleted,
		store: world.store,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	}
}

async function runAgainst(mode: Mode) {
	const backend = await serve(mode)
	const result = await run({
		baseUrl: backend.url,
		principals: { alpha: {} },
		seed: 1,
		spec: `${backend.url}/v1/openapi/spec`,
	})
	return { ...backend, result }
}

/* A value oat did not have, sent as text: never, whatever the answer looked like. */
function sentUndefined(result: Awaited<ReturnType<typeof run>>): string[] {
	return result.client.transcript
		.map((exchange) => decodeURIComponent(exchange.url))
		.filter((url) => /[/=]undefined(?:[/&?]|$)/.test(url))
}

describe("a create's id", () => {
	it("is read out of an envelope, so every record the run made is removed, checks' own included", async () => {
		const { result, store } = await runAgainst("envelope")
		expect(result.checksRun).toContain("concurrency.no-lost-update")
		expect(result.teardown?.unidentified ?? []).toEqual([])
		expect([...store.keys()]).toEqual([])
		expect(sentUndefined(result)).toEqual([])
	}, 120_000)

	it("comes from a declared createdIdFrom before anything else the answer carries", async () => {
		const { deleted, result, store } = await runAgainst("decoy")
		expect(result.teardown?.unidentified ?? []).toEqual([])
		expect([...store.keys()]).toEqual([])
		expect(deleted.filter((id) => Number(id) > 9000 && Number(id) < 10_000)).toEqual([])
	}, 120_000)

	it("is never a nested related record's id", async () => {
		const { deleted, result } = await runAgainst("nested-only")
		expect(deleted).not.toContain(String(STATUS_ID))
		expect(sentUndefined(result)).toEqual([])
		expect(result.teardown?.unidentified.length ?? 0).toBeGreaterThan(0)
	}, 120_000)

	it("when nothing names it, is a leftover that fails the run with its own exit code", async () => {
		const { result, store } = await runAgainst("ack")
		expect(store.size).toBeGreaterThan(0)
		const unidentified = result.teardown?.unidentified ?? []
		expect(unidentified.length).toBeGreaterThan(0)
		expect(unidentified[0]).toMatchObject({ entity: "note", operationId: "note.create" })
		expect(exitCode(result)).toBe(EXIT.leftovers)
		expect(sentUndefined(result)).toEqual([])
	}, 120_000)
})
