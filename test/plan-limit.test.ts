import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../src/runtime/run.ts"
import { isPlanLimitResponse } from "../src/runtime/world.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

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

const TABLE = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const ROW = {
	properties: { id: { type: "string" }, name: { type: "string" }, table_id: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function spec(): OpenApiDocument {
	return {
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
										properties: { items: { items: TABLE, type: "array" } },
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
						"201": { content: { "application/json": { schema: TABLE } }, description: "created" },
						"402": { description: "payment_required — table plan limit" },
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
					responses: { "200": { content: { "application/json": { schema: TABLE } }, description: "ok" } },
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
										properties: { items: { items: ROW, type: "array" } },
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
						"201": { content: { "application/json": { schema: ROW } }, description: "created" },
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
					responses: { "200": { content: { "application/json": { schema: ROW } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "row" },
				},
			},
		},
	} as OpenApiDocument
}

async function serve(seedTable: boolean): Promise<{
	close: () => Promise<void>
	tableCreates: () => number
	url: string
}> {
	const document = spec()
	const tables = new Map<string, { id: string; name: string }>()
	const rows = new Map<string, { id: string; name: string; table_id: string }>()
	if (seedTable) tables.set("tbl_extract", { id: "tbl_extract", name: "from-extract" })
	let tableCreates = 0
	let rowSeq = 0

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, document)
			if (url.pathname === "/v1/tables" && method === "GET") return send(res, 200, { items: [...tables.values()] })
			if (url.pathname === "/v1/tables" && method === "POST") {
				tableCreates += 1
				await readJson(req)
				return send(res, 402, {
					error_key: "table_plan_limit",
					status: 402,
					status_key: "payment_required",
				})
			}
			const tableItem = /^\/v1\/tables\/([^/]+)$/.exec(url.pathname)
			if (tableItem !== null && method === "GET") {
				const row = tables.get(decodeURIComponent(tableItem[1] ?? ""))
				return row === undefined ? send(res, 404) : send(res, 200, row)
			}
			if (tableItem !== null && method === "DELETE") {
				tables.delete(decodeURIComponent(tableItem[1] ?? ""))
				return send(res, 204)
			}
			const rowCol = /^\/v1\/tables\/([^/]+)\/rows$/.exec(url.pathname)
			if (rowCol !== null && method === "GET") {
				const tableId = decodeURIComponent(rowCol[1] ?? "")
				return send(res, 200, { items: [...rows.values()].filter((r) => r.table_id === tableId) })
			}
			if (rowCol !== null && method === "POST") {
				const tableId = decodeURIComponent(rowCol[1] ?? "")
				if (!tables.has(tableId)) return send(res, 404, { error: "missing table" })
				const body = ((await readJson(req)) ?? {}) as { name?: string }
				rowSeq += 1
				const row = { id: `row_${String(rowSeq)}`, name: body.name ?? "n", table_id: tableId }
				rows.set(row.id, row)
				return send(res, 201, row)
			}
			const rowItem = /^\/v1\/tables\/([^/]+)\/rows\/([^/]+)$/.exec(url.pathname)
			if (rowItem !== null && method === "GET") {
				const row = rows.get(decodeURIComponent(rowItem[2] ?? ""))
				return row === undefined ? send(res, 404) : send(res, 200, row)
			}
			if (rowItem !== null && method === "DELETE") {
				rows.delete(decodeURIComponent(rowItem[2] ?? ""))
				return send(res, 204)
			}
			return send(res, 404)
		})().catch(() => {
			if (!res.headersSent) send(res, 500)
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
		tableCreates: () => tableCreates,
		url: `http://127.0.0.1:${addr.port}`,
	}
}

const worlds: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
	await Promise.all(worlds.splice(0).map((w) => w.close()))
})

describe("plan-limit adopt", () => {
	it("recognises 402 and table_plan_limit", () => {
		expect(isPlanLimitResponse(402, { error: "nope" })).toBe(true)
		expect(isPlanLimitResponse(400, { error_key: "table_plan_limit", status_key: "payment_required" })).toBe(true)
		expect(isPlanLimitResponse(429, { error_key: "table_plan_limit" })).toBe(false)
		expect(isPlanLimitResponse(400, { error: "bad_request" })).toBe(false)
	})

	it("seeds row from an effect-created table when table.create 402s", async () => {
		const world = await serve(true)
		worlds.push(world)
		const result = await run({
			baseUrl: world.url,
			keepFixtures: true,
			only: ["table", "row"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${world.url}/v1/openapi/spec`,
		})
		const rowBlocked = result.findings.filter(
			(f) => f.verdict === "BLOCKED" && f.entity === "row" && /could not seed/.test(f.summary),
		)
		const invented = result.client.transcript.some(
			(e) => e.method === "POST" && new URL(e.url).pathname === "/v1/tables" && e.status < 300,
		)
		expect(rowBlocked).toEqual([])
		expect(result.entitiesTested).toContain("row")
		expect(invented).toBe(false)
		expect(world.tableCreates()).toBeGreaterThan(0)
		expect(result.findings.some((f) => f.verdict === "BACKEND_BUG" && e402(f.detail))).toBe(false)
	})

	it("does not invent a table when the list is empty", async () => {
		const world = await serve(false)
		worlds.push(world)
		const result = await run({
			baseUrl: world.url,
			keepFixtures: true,
			only: ["table", "row"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${world.url}/v1/openapi/spec`,
		})
		const rowBlocked = result.findings.some((f) => f.verdict === "BLOCKED" && f.entity === "row")
		const invented = result.client.transcript.some(
			(e) => e.method === "POST" && new URL(e.url).pathname.endsWith("/tables") && e.status < 300,
		)
		expect(rowBlocked).toBe(true)
		expect(invented).toBe(false)
	})
})

function e402(detail: string): boolean {
	return detail.includes("402") && detail.includes("plan")
}
