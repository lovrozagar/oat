import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"

/*
 * A minted API key the run removes before teardown, as the contract floor removes one with the
 * key entity's DELETE, is not revoked again: the backend answers 400 to a DELETE of a key already
 * gone, and that answer is no leftover. A key a revoke left in place still is one.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

type Handler = (req: IncomingMessage, res: ServerResponse) => void

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

async function serve(handler: Handler): Promise<{ url: string }> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	closers.push(
		() =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
	)
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const idParam = { in: "path", name: "id", required: true, schema: { type: "string" } }
const key = { properties: { id: { type: "string" }, secret: { type: "string" } }, type: "object" }
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })

/* Keys a session mints, lists, reads and deletes, and an operation only a key opens. */
const SPEC = {
	components: {
		securitySchemes: {
			api_key: { in: "header", name: "x-api-key", type: "apiKey" },
			bearer: { scheme: "bearer", type: "http" },
		},
	},
	info: { title: "keys", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/login": {
			post: {
				operationId: "login",
				responses: {
					"200": { description: "ok", ...json({ properties: { token: { type: "string" } }, type: "object" }) },
				},
				security: [],
			},
		},
		"/keys": {
			get: {
				operationId: "listKeys",
				responses: { "200": { description: "ok", ...json({ items: key, type: "array" }) } },
			},
			post: {
				operationId: "createKey",
				requestBody: json({ properties: { name: { type: "string" } }, type: "object" }),
				responses: { "201": { description: "made", ...json(key) } },
			},
		},
		"/keys/{id}": {
			delete: {
				operationId: "deleteKey",
				parameters: [idParam],
				responses: { "204": { description: "gone" }, "400": { description: "no such key" } },
			},
			get: {
				operationId: "getKey",
				parameters: [idParam],
				responses: { "200": { description: "ok", ...json(key) }, "404": { description: "none" } },
			},
		},
		"/me": {
			get: {
				operationId: "getMe",
				responses: { "200": { description: "ok" }, "401": { description: "refused" } },
				security: [{ api_key: [] }],
			},
		},
	},
	security: [{ bearer: [] }],
}

interface KeysApi {
	handler: Handler
	/** Each DELETE of a key, as `<id> <status>`. */
	deletes: string[]
}

/*
 * A login opens a session, which mints `key-<n>` (id `<n>`) and reads and lists the keys held. A
 * DELETE of a key already gone answers 400, as Immich does; `keeps` refuses every DELETE.
 */
function keysApi({ keeps = false }: { keeps?: boolean } = {}): KeysApi {
	const held = new Set<string>()
	const deletes: string[] = []
	let sessions = 0
	let minted = 0
	/* One key's own routes: its read, and its DELETE. */
	const keyRoute = (req: IncomingMessage, res: ServerResponse, id: string): void => {
		if (req.method === "GET") return send(res, held.has(id) ? 200 : 404, { id })
		if (req.method !== "DELETE") return send(res, 405)
		const status = !held.has(id) || keeps ? 400 : 204
		if (status === 204) held.delete(id)
		deletes.push(`${id} ${status}`)
		return send(res, status)
	}
	const handler: Handler = (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi.json") return send(res, 200, SPEC)
		/* It refuses every key, so the revoked-credential check proves none and stops before its revoke. */
		if (url.pathname === "/me") return send(res, 400)
		if (url.pathname === "/login" && req.method === "POST") return send(res, 200, { token: `session-${++sessions}` })
		if (!String(req.headers.authorization).startsWith("Bearer session-")) return send(res, 401)
		if (url.pathname === "/keys" && req.method === "GET")
			return send(
				res,
				200,
				[...held].map((id) => ({ id })),
			)
		if (url.pathname === "/keys" && req.method === "POST") {
			const id = String(++minted)
			held.add(id)
			return send(res, 201, { id, secret: `key-${id}` })
		}
		const id = /^\/keys\/([^/]+)$/.exec(url.pathname)?.[1]
		return id === undefined ? send(res, 404) : keyRoute(req, res, id)
	}
	return { deletes, handler }
}

/*
 * Targets deleteKey. The revoked-credential check mints a dedicated key and stops before its revoke,
 * since getMe refuses it; the contract floor then deletes that key with a dedicated session.
 */
async function runOver(api: KeysApi) {
	const { url } = await serve(api.handler)
	return run({
		baseUrl: url,
		ops: ["deleteKey"],
		principals: { alpha: {} },
		security: {
			api_key: {
				mint: {
					body: { name: "oat" },
					from: "$.secret",
					operationId: "createKey",
					revoke: "deleteKey",
					with: "bearer",
				},
			},
			bearer: { login: { from: "$.token", steps: [{ operationId: "login" }] } },
		},
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("a minted key the run already removed", () => {
	it("is not revoked again at teardown, nor counted left behind", async () => {
		const api = keysApi()
		const result = await runOver(api)
		/* The contract floor's delete, and no revoke after it. */
		expect([api.deletes, result.teardown]).toEqual([["1 204"], null])
	})

	it("stays a leftover when its revoke is refused and a read shows it still there", async () => {
		const api = keysApi({ keeps: true })
		const result = await runOver(api)
		expect(api.deletes).toEqual(["1 400", "1 400"])
		expect(result.teardown?.failed).toEqual([
			{ entity: "credential", id: "alpha/api_key", principal: "alpha", reason: "revoke deleteKey answered 400" },
		])
	})
})
