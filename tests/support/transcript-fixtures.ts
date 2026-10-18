import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtemp } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Servers and specs for the transcript integration tests. A server is returned with its own close,
 * so the test that started it owns its teardown.
 */

export type Listening = { close: () => Promise<void>; url: string }

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Listening> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

export async function scratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "oat-tr-"))
}

/* Drains the request, then answers 201 with the body `created()` returns; a read error is a 500. */
export function drainThenCreate(req: IncomingMessage, res: ServerResponse, created: () => unknown): void {
	void (async () => {
		req.resume()
		await new Promise<void>((resolve, reject) => {
			req.on("end", resolve)
			req.on("error", reject)
		})
		res.writeHead(201, { "content-type": "application/json" })
		res.end(JSON.stringify(created()))
	})().catch(() => {
		if (!res.headersSent) res.writeHead(500)
		res.end()
	})
}

const idSchema = { properties: { id: { type: "string" } }, type: "object" }

/* An upload entity: a list, and a multipart create that takes one binary file. */
export function uploadSpec(): OpenApiDocument {
	const listSchema = {
		properties: { uploads: { items: idSchema, type: "array" } },
		type: "object",
	}
	const fileSchema = {
		properties: {
			file: { contentMediaType: "application/octet-stream", format: "binary", type: "string" },
		},
		required: ["file"],
		type: "object",
	}
	return {
		info: { title: "upload", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/uploads": {
				get: {
					operationId: "upload.list",
					responses: { "200": { content: { "application/json": { schema: listSchema } }, description: "ok" } },
					"x-entity": { action: "list", identity: "id", name: "upload" },
				},
				post: {
					operationId: "upload.once",
					requestBody: { content: { "multipart/form-data": { schema: fileSchema } }, required: true },
					responses: {
						"201": { content: { "application/json": { schema: idSchema } }, description: "created" },
					},
					"x-entity": { action: "create", identity: "id", name: "upload" },
				},
			},
		},
	} as OpenApiDocument
}

/* Serves the upload spec, an empty list, and a fresh id for every create. */
export function serveUploads(): Promise<Listening> {
	const spec = uploadSpec()
	let seq = 0
	return listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(spec))
			return
		}
		if ((req.method ?? "").toUpperCase() === "GET" && url.pathname === "/uploads") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ uploads: [] }))
			return
		}
		drainThenCreate(req, res, () => ({ id: `u_${(seq += 1)}` }))
	})
}

function hangSpec(): OpenApiDocument {
	return {
		info: { title: "hang", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/items": {
				get: {
					operationId: "item.list",
					responses: { "200": { description: "ok" } },
					"x-entity": { action: "list", identity: "id", name: "item" },
				},
				post: {
					operationId: "item.create",
					requestBody: {
						content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
					},
					responses: { "201": { description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "item" },
				},
			},
		},
	} as OpenApiDocument
}

/* A host that answers the create but never ends the list's event stream. */
export function serveHungList(): Promise<Listening> {
	const spec = hangSpec()
	return listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(spec))
			return
		}
		if (url.pathname === "/v1/items" && (req.method ?? "") === "GET") {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write(`:${"y".repeat(1024)}\n`)
			return
		}
		res.writeHead(201, { "content-type": "application/json" })
		res.end(JSON.stringify({ id: "1", name: "n" }))
	})
}
