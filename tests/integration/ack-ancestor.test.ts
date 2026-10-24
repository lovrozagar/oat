import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { JsonSchema, OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Two ways a client-chosen identity with an acknowledgment-only create can trip oat:
 *  - as a parent: notes live under a folder, and the folder's create answers `{ success: true }`.
 *    oat must still make the folder, use the id it sent once a read confirms it, and remove it.
 *  - in a small id space: every create oat sends, checks included, must avoid the ids its own
 *    seeded records already hold, or the backend answers 409 and the check learns nothing.
 */

type Folder = { id: number; name: string }
type Note = { id: string; folder_id: number; title: string }

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function list(schema: unknown) {
	return { content: { "application/json": { schema: { items: schema, type: "array" } } }, description: "ok" }
}

const NOTE = {
	properties: {
		folder_id: { readOnly: true, type: "integer" },
		id: { readOnly: true, type: "string" },
		title: { minLength: 1, type: "string" },
	},
	required: ["title"],
	type: "object",
}
const ACK = {
	content: { "application/json": { schema: { properties: { success: { type: "boolean" } }, type: "object" } } },
	description: "ok",
}
const FOLDER_ID = { in: "path", name: "folderId", required: true, schema: { type: "integer" } }
const NOTE_ID = { in: "path", name: "noteId", required: true, schema: { type: "string" } }

function folderSchema(space: number): JsonSchema {
	return {
		additionalProperties: false,
		properties: { id: { maximum: space, minimum: 1, type: "integer" }, name: { minLength: 1, type: "string" } },
		required: ["id", "name"],
		type: "object",
	}
}

function folderPaths(folder: Record<string, unknown>): Record<string, unknown> {
	return {
		"/folders": {
			get: { operationId: "folder.list", responses: { "200": list(folder) } },
			post: {
				operationId: "folder.create",
				requestBody: { content: { "application/json": { schema: folder } }, required: true },
				responses: { "201": ACK, "400": { description: "invalid" }, "409": { description: "taken" } },
				"x-unique": [["id"]],
			},
		},
		"/folders/{folderId}": {
			delete: {
				operationId: "folder.delete",
				parameters: [FOLDER_ID],
				responses: { "204": { description: "gone" }, "404": { description: "missing" } },
			},
			get: {
				operationId: "folder.get",
				parameters: [FOLDER_ID],
				responses: {
					"200": { content: { "application/json": { schema: folder } }, description: "ok" },
					"404": { description: "missing" },
				},
			},
		},
	}
}

function notePaths(): Record<string, unknown> {
	return {
		"/folders/{folderId}/notes": {
			get: { operationId: "note.list", parameters: [FOLDER_ID], responses: { "200": list(NOTE) } },
			post: {
				operationId: "note.create",
				parameters: [FOLDER_ID],
				requestBody: { content: { "application/json": { schema: NOTE } }, required: true },
				responses: {
					"201": { content: { "application/json": { schema: NOTE } }, description: "created" },
					"400": { description: "invalid" },
				},
			},
		},
		"/folders/{folderId}/notes/{noteId}": {
			delete: {
				operationId: "note.delete",
				parameters: [FOLDER_ID, NOTE_ID],
				responses: { "204": { description: "gone" }, "404": { description: "missing" } },
			},
			get: {
				operationId: "note.get",
				parameters: [FOLDER_ID, NOTE_ID],
				responses: {
					"200": { content: { "application/json": { schema: NOTE } }, description: "ok" },
					"404": { description: "missing" },
				},
			},
		},
	}
}

function spec(space: number): OpenApiDocument {
	return {
		info: { title: "ack-ancestor", version: "1" },
		openapi: "3.1.0",
		paths: { ...folderPaths(folderSchema(space)), ...notePaths() },
	} as OpenApiDocument
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const raw = Buffer.concat(chunks).toString("utf8")
	return raw === "" ? undefined : JSON.parse(raw)
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(body === undefined ? "" : JSON.stringify(body))
}

type World = { folders: Map<number, Folder>; next: number; notes: Map<string, Note>; space: number }

type Exchange = { method: string; parts: string[]; req: IncomingMessage; res: ServerResponse; world: World }

function validFolder(body: Partial<Folder> | undefined, space: number): body is Folder {
	return (
		typeof body?.id === "number" &&
		body.id >= 1 &&
		body.id <= space &&
		typeof body.name === "string" &&
		body.name !== ""
	)
}

async function folderCollection({ method, req, res, world }: Exchange): Promise<void> {
	if (method === "GET") return send(res, 200, [...world.folders.values()])
	const body = (await readJson(req)) as Partial<Folder> | undefined
	if (!validFolder(body, world.space)) return send(res, 400, { error: "invalid" })
	if (world.folders.has(body.id)) return send(res, 409, { error: "taken" })
	world.folders.set(body.id, { id: body.id, name: body.name })
	send(res, 201, { success: true })
}

function folderItem({ method, parts, res, world }: Exchange, folder: Folder | undefined): void {
	if (method === "GET") return folder === undefined ? send(res, 404, {}) : send(res, 200, folder)
	return world.folders.delete(Number(parts[1])) ? send(res, 204) : send(res, 404, {})
}

async function noteCollection({ method, req, res, world }: Exchange, folder: Folder): Promise<void> {
	if (method === "GET")
		return send(
			res,
			200,
			[...world.notes.values()].filter((note) => note.folder_id === folder.id),
		)
	const body = (await readJson(req)) as Partial<Note> | undefined
	if (typeof body?.title !== "string" || body.title === "") return send(res, 400, { error: "title" })
	const note = { folder_id: folder.id, id: `n${world.next++}`, title: body.title }
	world.notes.set(note.id, note)
	send(res, 201, note)
}

function noteItem({ method, parts, res, world }: Exchange): void {
	const note = world.notes.get(parts[3] ?? "")
	if (method === "GET") return note === undefined ? send(res, 404, {}) : send(res, 200, note)
	if (method === "DELETE") return world.notes.delete(parts[3] ?? "") ? send(res, 204) : send(res, 404, {})
	send(res, 405, {})
}

/* Routes by path depth: /folders, /folders/:id, /folders/:id/notes, then a note. */
async function route(exchange: Exchange): Promise<void> {
	const { method, parts, res, world } = exchange
	if (parts[0] !== "folders") return send(res, 404, {})
	if (parts.length === 1) return folderCollection(exchange)
	const folder = world.folders.get(Number(parts[1]))
	if (parts.length === 2 && (method === "GET" || method === "DELETE")) return folderItem(exchange, folder)
	if (folder === undefined) return send(res, 404, {})
	if (parts.length === 3) return noteCollection(exchange, folder)
	noteItem(exchange)
}

async function serve(space: number, folders: Map<number, Folder>, notes: Map<string, Note>): Promise<string> {
	const document = spec(space)
	const world: World = { folders, next: 1, notes, space }
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi.json") return send(res, 200, document)
			const method = (req.method ?? "GET").toUpperCase()
			await route({ method, parts: url.pathname.split("/").filter(Boolean), req, res, world })
		})().catch(() => {
			if (!res.headersSent) res.writeHead(500)
			res.end()
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

async function runAgainst(space: number) {
	const folders = new Map<number, Folder>()
	const notes = new Map<string, Note>()
	const url = await serve(space, folders, notes)
	const result = await run({
		baseUrl: url,
		cohortSize: 3,
		principals: { alpha: {} },
		seed: 1,
		spec: `${url}/openapi.json`,
	})
	return { folders, notes, result }
}

describe("an acknowledgment-only parent with a client-chosen id", () => {
	it("is created, confirmed, used as the child's parent, and removed", async () => {
		const { folders, notes, result } = await runAgainst(999)
		expect(result.findings.filter((finding) => finding.check === "world.seed")).toEqual([])
		expect(result.entitiesTested).toContain("note")
		expect([...folders.keys()]).toEqual([])
		expect([...notes.keys()]).toEqual([])
	})
})

describe("a small client-chosen id space", () => {
	it("never makes a check collide with an id oat's own records hold", async () => {
		const { result } = await runAgainst(5)
		expect(result.inconclusive.filter((entry) => /answered 409/.test(entry.reason))).toEqual([])
	})
})
