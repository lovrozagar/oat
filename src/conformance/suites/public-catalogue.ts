import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

const PUBLIC_CATALOGUE_SPEC = {
	info: { title: "Public catalogue", version: "1.0" },
	openapi: "3.1.0",
	paths: {
		"/v1/templates": {
			get: {
				operationId: "template.list",
				parameters: [
					{
						description: "PostgREST filter expression, e.g. id.eq.value",
						in: "query",
						name: "filter",
						required: false,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										templates: {
											items: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
											type: "array",
										},
									},
									required: ["templates"],
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "template" },
			},
			post: {
				operationId: "template.create",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								additionalProperties: false,
								properties: { name: { maxLength: 128, type: "string" } },
								required: ["name"],
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: {
					"201": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
							},
						},
						description: "created",
					},
				},
				"x-entity": { action: "create", identity: "id", name: "template" },
			},
		},
		"/v1/templates/{template_id}": {
			delete: {
				operationId: "template.delete",
				parameters: [{ in: "path", name: "template_id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "deleted" } },
				"x-entity": { action: "delete", identity: "id", name: "template" },
			},
			get: {
				operationId: "template.read",
				parameters: [{ in: "path", name: "template_id", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "read", identity: "id", name: "template" },
			},
		},
	},
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			if (text === "") {
				resolve(undefined)
				return
			}
			try {
				resolve(JSON.parse(text) as unknown)
			} catch (error) {
				reject(error)
			}
		})
		req.on("error", reject)
	})
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) })
	res.end(text)
}

export async function servePublicCatalogue(): Promise<{ close: () => Promise<void>; url: string }> {
	const rows = new Map<string, { id: string; name: string }>()
	let seq = 0
	const tokens = new Set(["tok_alpha", "tok_beta"])

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") {
				return send(res, 200, PUBLIC_CATALOGUE_SPEC)
			}
			const header = req.headers.authorization
			if (typeof header !== "string" || !header.startsWith("Bearer ") || !tokens.has(header.slice(7).trim())) {
				return send(res, 401, { error: "unauthorized" })
			}
			if (url.pathname === "/v1/templates" && method === "GET") {
				const raw = url.searchParams.get("filter")
				const match = raw === null ? null : /^id\.eq\.(.+)$/.exec(raw)
				if (match !== null) {
					const row = rows.get(match[1] ?? "")
					return send(res, 200, { templates: row === undefined ? [] : [row] })
				}
				return send(res, 200, { templates: [...rows.values()] })
			}
			if (url.pathname === "/v1/templates" && method === "POST") {
				const body = (await readJson(req)) as { name?: unknown }
				const name = typeof body?.name === "string" ? body.name : ""
				const id = `tmpl_${String((seq += 1))}`
				const row = { id, name }
				rows.set(id, row)
				return send(res, 201, row)
			}
			const item = /^\/v1\/templates\/([^/]+)$/.exec(url.pathname)
			if (item !== null && method === "GET") {
				const row = rows.get(decodeURIComponent(item[1] ?? ""))
				return row === undefined ? send(res, 404, { error: "not_found" }) : send(res, 200, row)
			}
			if (item !== null && method === "DELETE") {
				const id = decodeURIComponent(item[1] ?? "")
				if (!rows.has(id)) return send(res, 404, { error: "not_found" })
				rows.delete(id)
				return send(res, 204)
			}
			return send(res, 404, { error: "not_found" })
		})().catch(() => {
			if (!res.headersSent) send(res, 500, { error: "internal" })
		})
	})

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
