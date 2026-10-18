import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A create that takes the record's id from the client and silently overwrites a record that
 * already has it (a config store keyed by id). Nothing declares the id unique, so only oat's own
 * care keeps it from choosing an id a record already holds — and destroying that record.
 */

type Row = { id: number; name: string }

const SPACE = 60

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(): OpenApiDocument {
	const note = {
		additionalProperties: false,
		properties: {
			id: { maximum: SPACE, minimum: 1, type: "integer" },
			name: { minLength: 1, type: "string" },
		},
		required: ["id", "name"],
		type: "object",
	}
	const ack = {
		content: { "application/json": { schema: { properties: { success: { type: "boolean" } }, type: "object" } } },
		description: "ok",
	}
	const idParam = [{ in: "path", name: "noteId", required: true, schema: { type: "integer" } }]
	return {
		info: { title: "overwriting-create", version: "1" },
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
					responses: { "200": ack, "400": { description: "invalid" } },
				},
			},
			"/notes/{noteId}": {
				delete: {
					operationId: "note.delete",
					parameters: idParam,
					responses: { "200": ack, "404": { description: "missing" } },
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

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

async function createNote(rows: Map<number, Row>, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = (await readJson(req)) as Partial<Row> | undefined
	if (typeof body?.id !== "number" || typeof body.name !== "string" || body.name === "") {
		return send(res, 400, { success: false })
	}
	/* An existing id is overwritten, not refused. */
	rows.set(body.id, { id: body.id, name: body.name })
	send(res, 200, { success: true })
}

/* The item path a request names, and its method. */
interface ItemRequest {
	pathname: string
	method: string
}

function noteItem(rows: Map<number, Row>, { method, pathname }: ItemRequest, res: ServerResponse): void {
	const id = Number(decodeURIComponent(pathname.match(/^\/notes\/([^/]+)$/)?.[1] ?? ""))
	const row = rows.get(id)
	if (method === "GET") return row === undefined ? send(res, 404, {}) : send(res, 200, row)
	if (method === "DELETE") return rows.delete(id) ? send(res, 200, { success: true }) : send(res, 404, {})
	send(res, 405, {})
}

async function serve(rows: Map<number, Row>): Promise<string> {
	const document = spec()
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json") return send(res, 200, document)
			if (url.pathname === "/notes" && method === "GET") return send(res, 200, [...rows.values()])
			if (url.pathname === "/notes" && method === "POST") return createNote(rows, req, res)
			noteItem(rows, { method, pathname: url.pathname }, res)
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

function existing(count: number): Map<number, Row> {
	const rows = new Map<number, Row>()
	for (let id = 1; id <= count; id++) rows.set(id, { id, name: `keep-${id}` })
	return rows
}

function intact(rows: Map<number, Row>, count: number): number {
	let kept = 0
	for (let id = 1; id <= count; id++) if (rows.get(id)?.name === `keep-${id}`) kept++
	return kept
}

async function runAgainst(url: string): Promise<void> {
	await run({
		baseUrl: url,
		cohortSize: 3,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("a create that overwrites whatever record already holds the id", () => {
	it("never sends an id an existing record holds", async () => {
		const rows = existing(50)
		await runAgainst(await serve(rows))
		expect(intact(rows, 50)).toBe(50)
	})

	it("still leaves every existing record alone when only a couple of ids are free", async () => {
		const rows = existing(SPACE - 2)
		await runAgainst(await serve(rows))
		expect(intact(rows, SPACE - 2)).toBe(SPACE - 2)
	})
})
