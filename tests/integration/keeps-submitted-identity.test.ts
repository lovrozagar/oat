import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * `create.keeps-submitted-identity`: a create that takes the record's id from the client and answers
 * only an acknowledgement must have stored the record under that id. A server that quietly picks
 * its own id has lost the client's handle on the record it just made.
 */

type Note = { id: string; name: string }
type Mode = "keeps" | "ignores" | "assigns"

const CHECK = "create.keeps-submitted-identity"

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(mode: Mode): OpenApiDocument {
	const clientId = mode !== "assigns"
	const note = {
		additionalProperties: false,
		properties: {
			id: clientId ? { minLength: 1, type: "string" } : { readOnly: true, type: "string" },
			name: { minLength: 1, type: "string" },
		},
		required: clientId ? ["id", "name"] : ["name"],
		type: "object",
	}
	const created = clientId
		? { content: { "application/json": { schema: { properties: { success: { type: "boolean" } }, type: "object" } } } }
		: { content: { "application/json": { schema: note } } }
	const idParam = [{ in: "path", name: "noteId", required: true, schema: { type: "string" } }]
	return {
		info: { title: "keeps-submitted-identity", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": { content: { "application/json": { schema: { items: note, type: "array" } } }, description: "ok" },
					},
				},
				post: {
					operationId: "note.create",
					requestBody: { content: { "application/json": { schema: note } }, required: true },
					responses: {
						"201": { ...created, description: "created" },
						"400": { description: "invalid" },
						"409": { description: "taken" },
					},
					...(clientId ? { "x-unique": [["id"]] } : {}),
				},
			},
			"/notes/{noteId}": {
				delete: {
					operationId: "note.delete",
					parameters: idParam,
					responses: { "204": { description: "gone" }, "404": { description: "missing" } },
				},
				get: {
					operationId: "note.get",
					parameters: idParam,
					responses: {
						"200": { content: { "application/json": { schema: note } }, description: "ok" },
						"404": { description: "missing" },
					},
				},
			},
		},
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

type World = { mode: Mode; next: number; notes: Map<string, Note> }

async function createNote(world: World, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = (await readJson(req)) as Partial<Note> | undefined
	if (typeof body?.name !== "string" || body.name === "") return send(res, 400, { error: "name" })
	if (world.mode === "assigns") {
		const note = { id: `srv-${world.next++}`, name: body.name }
		world.notes.set(note.id, note)
		return send(res, 201, note)
	}
	if (typeof body.id !== "string" || body.id === "") return send(res, 400, { error: "id" })
	if (world.notes.has(body.id)) return send(res, 409, { error: "taken" })
	/* "ignores" stores the record under an id of its own and still acknowledges. */
	const id = world.mode === "ignores" ? `srv-${world.next++}` : body.id
	world.notes.set(id, { id, name: body.name })
	send(res, 201, { success: true })
}

function noteItem(notes: Map<string, Note>, pathname: string, method: string, res: ServerResponse): void {
	const id = decodeURIComponent(pathname.match(/^\/notes\/([^/]+)$/)?.[1] ?? "")
	const note = notes.get(id)
	if (method === "GET") return note === undefined ? send(res, 404, { error: "missing" }) : send(res, 200, note)
	if (method === "DELETE") return notes.delete(id) ? send(res, 204) : send(res, 404, { error: "missing" })
	send(res, 405, {})
}

async function serve(mode: Mode): Promise<string> {
	const document = spec(mode)
	const world: World = { mode, next: 1, notes: new Map() }
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json") return send(res, 200, document)
			if (url.pathname === "/notes" && method === "GET") return send(res, 200, [...world.notes.values()])
			if (url.pathname === "/notes" && method === "POST") return createNote(world, req, res)
			noteItem(world.notes, url.pathname, method, res)
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

async function runAgainst(mode: Mode): Promise<Awaited<ReturnType<typeof run>>> {
	const url = await serve(mode)
	return run({
		baseUrl: url,
		cohortSize: 3,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("create.keeps-submitted-identity", () => {
	it("passes a create that stored the record under the id the client chose", async () => {
		const result = await runAgainst("keeps")
		const create = result.scope.operations.find((op) => op.operationId === "note.create")
		expect(create?.checks.passed).toContain(CHECK)
		expect(result.findings.filter((finding) => finding.check === CHECK)).toEqual([])
	})

	it("reports a create that acknowledged and stored the record under an id of its own", async () => {
		const result = await runAgainst("ignores")
		const findings = result.findings.filter((finding) => finding.check === CHECK)
		expect(findings.map((finding) => finding.verdict)).toEqual(["BACKEND_BUG"])
		expect(findings[0]?.detail).toMatch(/was sent "[^"]+"/)
	})

	it("does not apply when the server assigns the id and answers with the record", async () => {
		const result = await runAgainst("assigns")
		expect(result.checksRun).not.toContain(CHECK)
	})
})
