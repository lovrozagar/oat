/**
 * Reactive 429 backoff and plan-limit adopt. Tags stay the proactive path; these cases prove
 * the first 429 is not a seed failure and that a 402 does not invent a table.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Client } from "../runtime/client.ts"
import { parseRetryAfter, retryWaitMs, RETRY_BACKOFF_CAP_MS } from "../runtime/rate-limit.ts"
import { run } from "../runtime/run.ts"
import { isPlanLimitResponse } from "../runtime/world.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import type { ParserResult } from "./suite.ts"

function send(res: ServerResponse, status: number, body?: unknown, extra?: Record<string, string>): void {
	if (body === undefined) {
		res.writeHead(status, extra)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, {
		"content-length": String(Buffer.byteLength(text)),
		"content-type": "application/json",
		...extra,
	})
	res.end(text)
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

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	close: () => Promise<void>
	url: string
}> {
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

const ITEM = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function thingSpec(): OpenApiDocument {
	return {
		info: { title: "untagged-429", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/things": {
				get: {
					operationId: "thing.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { items: { items: ITEM, type: "array" } },
										required: ["items"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "thing" },
				},
				post: {
					operationId: "thing.create",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
							},
						},
						required: true,
					},
					responses: {
						"201": { content: { "application/json": { schema: ITEM } }, description: "created" },
					},
					"x-entity": { action: "create", identity: "id", name: "thing" },
				},
			},
			"/v1/things/{id}": {
				delete: {
					operationId: "thing.delete",
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", identity: "id", name: "thing" },
				},
				get: {
					operationId: "thing.read",
					responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "thing" },
				},
			},
		},
	} as OpenApiDocument
}

export async function runRateLimitSuite(): Promise<ParserResult[]> {
	const results: ParserResult[] = []
	const push = (name: string, why: string, ok: boolean, detail: string): void => {
		results.push({ detail, name, ok, why })
	}

	push(
		"Retry-After delta-seconds and exponential cap",
		"pure wait math must not hang a tester",
		parseRetryAfter("1") === 1000 && retryWaitMs(undefined, 8) === RETRY_BACKOFF_CAP_MS,
		`delta=${String(parseRetryAfter("1"))} cap=${String(retryWaitMs(undefined, 8))}`,
	)
	push(
		"402 and table_plan_limit are plan limits; 429 is not",
		"reuse is 402-only",
		isPlanLimitResponse(402, {}) &&
			isPlanLimitResponse(400, { error_key: "table_plan_limit" }) &&
			!isPlanLimitResponse(429, { error_key: "table_plan_limit" }),
		"ok",
	)

	try {
		let posts = 0
		const rows = new Map<string, { id: string; name: string }>()
		const document = thingSpec()
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, document)
				if (url.pathname === "/v1/things" && method === "GET") return send(res, 200, { items: [...rows.values()] })
				if (url.pathname === "/v1/things" && method === "POST") {
					posts += 1
					if (posts === 1) return send(res, 429, { error: "too_many_requests" }, { "retry-after": "0" })
					const id = `t_${String(posts)}`
					const row = { id, name: "n" }
					rows.set(id, row)
					return send(res, 201, row)
				}
				const item = /^\/v1\/things\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "DELETE") {
					rows.delete(item[1] ?? "")
					return send(res, 204)
				}
				if (item !== null && method === "GET") {
					const row = rows.get(item[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		try {
			const client = new Client(server.url)
			const first = await client.request("POST", "/v1/things", { body: { name: "n" } })
			push(
				"Client.request retries a 429 with Retry-After and returns 201",
				"first 429 is not the result",
				first.status === 201 && client.transcript.map((e) => e.status).join(",") === "429,201",
				`status=${first.status} seq=${client.transcript.map((e) => e.status).join(",")}`,
			)

			const result = await run({
				baseUrl: server.url,
				keepFixtures: true,
				only: ["thing"],
				principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
				seed: 1,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const blocked = result.findings.filter((f) => f.verdict === "BLOCKED" && f.check === "world.seed")
			push(
				"seed is not failed by the first 429 on an untagged create",
				"no x-rate-limit required",
				blocked.length === 0 && result.entitiesTested.includes("thing"),
				`blocked=${blocked.length} entities=${result.entitiesTested.join(",")}`,
			)
		} finally {
			await server.close()
		}
	} catch (error) {
		push(
			"Client.request retries a 429 with Retry-After and returns 201",
			"first 429 is not the result",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const tables = new Map<string, { id: string; name: string }>([
			["tbl_extract", { id: "tbl_extract", name: "from-extract" }],
		])
		const rows = new Map<string, { id: string; name: string; table_id: string }>()
		let rowSeq = 0
		const document = {
			info: { title: "plan-limit", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/tables": {
					get: {
						operationId: "table.list",
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: {
											properties: { items: { items: ITEM, type: "array" } },
											required: ["items"],
											type: "object",
										},
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "list", identity: "id", name: "table" },
					},
					post: {
						operationId: "table.create",
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
								},
							},
							required: true,
						},
						responses: {
							"201": { content: { "application/json": { schema: ITEM } }, description: "created" },
							"402": { description: "payment_required" },
						},
						"x-entity": { action: "create", identity: "id", name: "table" },
					},
				},
				"/v1/tables/{table_id}": {
					delete: {
						operationId: "table.delete",
						parameters: [{ in: "path", name: "table_id", required: true, schema: { type: "string" } }],
						responses: { "204": { description: "gone" } },
						"x-entity": { action: "delete", identity: "id", name: "table" },
					},
					get: {
						operationId: "table.read",
						parameters: [{ in: "path", name: "table_id", required: true, schema: { type: "string" } }],
						responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
						"x-entity": { action: "read", identity: "id", name: "table" },
					},
				},
				"/v1/tables/{table_id}/rows": {
					get: {
						operationId: "row.list",
						parameters: [{ in: "path", name: "table_id", required: true, schema: { type: "string" } }],
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: {
											properties: { items: { items: ITEM, type: "array" } },
											required: ["items"],
											type: "object",
										},
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "list", identity: "id", name: "row" },
					},
					post: {
						operationId: "row.create",
						parameters: [{ in: "path", name: "table_id", required: true, schema: { type: "string" } }],
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
								},
							},
							required: true,
						},
						responses: {
							"201": { content: { "application/json": { schema: ITEM } }, description: "created" },
						},
						"x-entity": { action: "create", identity: "id", name: "row" },
					},
				},
				"/v1/tables/{table_id}/rows/{row_id}": {
					delete: {
						operationId: "row.delete",
						parameters: [
							{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
							{ in: "path", name: "row_id", required: true, schema: { type: "string" } },
						],
						responses: { "204": { description: "gone" } },
						"x-entity": { action: "delete", identity: "id", name: "row" },
					},
					get: {
						operationId: "row.read",
						parameters: [
							{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
							{ in: "path", name: "row_id", required: true, schema: { type: "string" } },
						],
						responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
						"x-entity": { action: "read", identity: "id", name: "row" },
					},
				},
			},
		} as OpenApiDocument
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, document)
				if (url.pathname === "/v1/tables" && method === "GET") return send(res, 200, { items: [...tables.values()] })
				if (url.pathname === "/v1/tables" && method === "POST") {
					return send(res, 402, { error_key: "table_plan_limit", status_key: "payment_required" })
				}
				const tableItem = /^\/v1\/tables\/([^/]+)$/.exec(url.pathname)
				if (tableItem !== null && method === "GET") {
					const row = tables.get(decodeURIComponent(tableItem[1] ?? ""))
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				if (tableItem !== null && method === "DELETE") return send(res, 204)
				const rowCol = /^\/v1\/tables\/([^/]+)\/rows$/.exec(url.pathname)
				if (rowCol !== null && method === "GET") return send(res, 200, { items: [...rows.values()] })
				if (rowCol !== null && method === "POST") {
					const tableId = decodeURIComponent(rowCol[1] ?? "")
					if (!tables.has(tableId)) return send(res, 404)
					const body = ((await readJson(req)) ?? {}) as { name?: string }
					rowSeq += 1
					const row = { id: `r_${String(rowSeq)}`, name: body.name ?? "n", table_id: tableId }
					rows.set(row.id, row)
					return send(res, 201, row)
				}
				const rowItem = /^\/v1\/tables\/([^/]+)\/rows\/([^/]+)$/.exec(url.pathname)
				if (rowItem !== null && method === "GET") {
					const row = rows.get(decodeURIComponent(rowItem[2] ?? ""))
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				if (rowItem !== null && method === "DELETE") return send(res, 204)
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		try {
			const result = await run({
				baseUrl: server.url,
				keepFixtures: true,
				only: ["table", "row"],
				principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
				seed: 1,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const rowBlocked = result.findings.some((f) => f.verdict === "BLOCKED" && f.entity === "row")
			const invented = result.client.transcript.some(
				(e) => e.method === "POST" && new URL(e.url).pathname === "/v1/tables" && e.status < 300,
			)
			const backend402 = result.findings.some((f) => f.verdict === "BACKEND_BUG" && f.detail.includes("402"))
			push(
				"row seeds after table.create 402 when a same-tenant table already exists",
				"do not invent tables; do not treat documented plan limit as a defect",
				!rowBlocked && !invented && !backend402 && result.entitiesTested.includes("row"),
				`blocked=${rowBlocked} invented=${invented} backend402=${backend402} tested=${result.entitiesTested.join(",")}`,
			)
		} finally {
			await server.close()
		}
	} catch (error) {
		push(
			"row seeds after table.create 402 when a same-tenant table already exists",
			"do not invent tables; do not treat documented plan limit as a defect",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	return results
}
