import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import { isPlanLimitResponse } from "../../src/runtime/world/plan-limit.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

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

function pathParam(name: string): Record<string, unknown> {
	return { in: "path", name, required: true, schema: { type: "string" } }
}

function listOk(item: Record<string, unknown>): Record<string, unknown> {
	return {
		"200": {
			content: {
				"application/json": {
					schema: { properties: { items: { items: item, type: "array" } }, required: ["items"], type: "object" },
				},
			},
			description: "ok",
		},
	}
}

const NAME_BODY = {
	content: {
		"application/json": {
			schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
		},
	},
	required: true,
}

function tablePaths(): Record<string, unknown> {
	return {
		"/v1/tables": {
			get: {
				operationId: "table.list",
				responses: listOk(TABLE),
				"x-entity": { action: "list", identity: "id", name: "table" },
			},
			post: {
				operationId: "table.create",
				requestBody: NAME_BODY,
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
				parameters: [pathParam("table_id")],
				responses: { "204": { description: "gone" } },
				"x-entity": { action: "delete", identity: "id", name: "table" },
			},
			get: {
				operationId: "table.read",
				parameters: [pathParam("table_id")],
				responses: { "200": { content: { "application/json": { schema: TABLE } }, description: "ok" } },
				"x-entity": { action: "read", identity: "id", name: "table" },
			},
		},
	}
}

function rowPaths(): Record<string, unknown> {
	return {
		"/v1/tables/{table_id}/rows": {
			get: {
				operationId: "row.list",
				parameters: [pathParam("table_id")],
				responses: listOk(ROW),
				"x-entity": { action: "list", identity: "id", name: "row" },
			},
			post: {
				operationId: "row.create",
				parameters: [pathParam("table_id")],
				requestBody: NAME_BODY,
				responses: {
					"201": { content: { "application/json": { schema: ROW } }, description: "created" },
				},
				"x-entity": { action: "create", identity: "id", name: "row" },
			},
		},
		"/v1/tables/{table_id}/rows/{row_id}": {
			delete: {
				operationId: "row.delete",
				parameters: [pathParam("table_id"), pathParam("row_id")],
				responses: { "204": { description: "gone" } },
				"x-entity": { action: "delete", identity: "id", name: "row" },
			},
			get: {
				operationId: "row.read",
				parameters: [pathParam("table_id"), pathParam("row_id")],
				responses: { "200": { content: { "application/json": { schema: ROW } }, description: "ok" } },
				"x-entity": { action: "read", identity: "id", name: "row" },
			},
		},
	}
}

function spec(): OpenApiDocument {
	return {
		info: { title: "plan-limit", version: "1" },
		openapi: "3.1.0",
		paths: { ...tablePaths(), ...rowPaths() },
	} as OpenApiDocument
}

type Table = { id: string; name: string }
type Row = { id: string; name: string; table_id: string }

/* The in-memory world behind the server: tables refuse every create with a plan-limit 402. */
type World = {
	document: OpenApiDocument
	rows: Map<string, Row>
	tables: Map<string, Table>
	tableCreates: number
	rowSeq: number
}

/* One request and the response that answers it. */
interface Exchange {
	req: IncomingMessage
	res: ServerResponse
}

type Route = {
	method: string
	path: RegExp
	handle: (world: World, match: RegExpExecArray, exchange: Exchange) => unknown
}

function param(match: RegExpExecArray, index: number): string {
	return decodeURIComponent(match[index] ?? "")
}

async function refuseTable(world: World, req: IncomingMessage, res: ServerResponse): Promise<void> {
	world.tableCreates += 1
	await readJson(req)
	send(res, 402, { error_key: "table_plan_limit", status: 402, status_key: "payment_required" })
}

async function createRow(world: World, tableId: string, { req, res }: Exchange): Promise<void> {
	if (!world.tables.has(tableId)) return send(res, 404, { error: "missing table" })
	const body = ((await readJson(req)) ?? {}) as { name?: string }
	world.rowSeq += 1
	const row = { id: `row_${String(world.rowSeq)}`, name: body.name ?? "n", table_id: tableId }
	world.rows.set(row.id, row)
	send(res, 201, row)
}

function sendFound(res: ServerResponse, value: unknown): void {
	if (value === undefined) send(res, 404)
	else send(res, 200, value)
}

const ROUTES: readonly Route[] = [
	{ handle: (w, _m, { res }) => send(res, 200, w.document), method: "GET", path: /^\/v1\/openapi\/spec$/ },
	{
		handle: (w, _m, { res }) => send(res, 200, { items: [...w.tables.values()] }),
		method: "GET",
		path: /^\/v1\/tables$/,
	},
	{ handle: (w, _m, { req, res }) => refuseTable(w, req, res), method: "POST", path: /^\/v1\/tables$/ },
	{
		handle: (w, m, { res }) => sendFound(res, w.tables.get(param(m, 1))),
		method: "GET",
		path: /^\/v1\/tables\/([^/]+)$/,
	},
	{
		handle: (w, m, { res }) => {
			w.tables.delete(param(m, 1))
			send(res, 204)
		},
		method: "DELETE",
		path: /^\/v1\/tables\/([^/]+)$/,
	},
	{
		handle: (w, m, { res }) =>
			send(res, 200, { items: [...w.rows.values()].filter((r) => r.table_id === param(m, 1)) }),
		method: "GET",
		path: /^\/v1\/tables\/([^/]+)\/rows$/,
	},
	{
		handle: (w, m, exchange) => createRow(w, param(m, 1), exchange),
		method: "POST",
		path: /^\/v1\/tables\/([^/]+)\/rows$/,
	},
	{
		handle: (w, m, { res }) => sendFound(res, w.rows.get(param(m, 2))),
		method: "GET",
		path: /^\/v1\/tables\/([^/]+)\/rows\/([^/]+)$/,
	},
	{
		handle: (w, m, { res }) => {
			w.rows.delete(param(m, 2))
			send(res, 204)
		},
		method: "DELETE",
		path: /^\/v1\/tables\/([^/]+)\/rows\/([^/]+)$/,
	},
]

async function dispatch(world: World, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")
	const method = (req.method ?? "GET").toUpperCase()
	for (const route of ROUTES) {
		const match = route.method === method ? route.path.exec(url.pathname) : null
		if (match !== null) {
			await route.handle(world, match, { req, res })
			return
		}
	}
	send(res, 404)
}

async function serve(seedTable: boolean): Promise<{
	close: () => Promise<void>
	tableCreates: () => number
	url: string
}> {
	const world: World = { document: spec(), rowSeq: 0, rows: new Map(), tableCreates: 0, tables: new Map() }
	if (seedTable) world.tables.set("tbl_extract", { id: "tbl_extract", name: "from-extract" })
	const server = createServer((req, res) => {
		dispatch(world, req, res).catch(() => {
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
		tableCreates: () => world.tableCreates,
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
