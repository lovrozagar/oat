import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * An entity nobody creates directly — a table's exports, a webhook's deliveries — is still listed
 * under a parent. Its checks need that parent's id, and oat can make the parent like any other.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const json = (schema: unknown) => ({ "application/json": { schema } })
const tableSchema = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}
const exportSchema = {
	properties: { created_at: { type: "string" }, id: { type: "string" } },
	required: ["id", "created_at"],
	type: "object",
}
const idParam = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

const spec = {
	info: { title: "exports", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/tables": {
			get: {
				operationId: "table.list",
				responses: {
					"200": {
						content: json({ properties: { items: { items: tableSchema, type: "array" } }, type: "object" }),
						description: "ok",
					},
				},
			},
			post: {
				operationId: "table.create",
				requestBody: json({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
				responses: { "201": { content: json(tableSchema), description: "made" } },
			},
		},
		"/v1/tables/{table_id}": {
			delete: {
				operationId: "table.delete",
				parameters: [idParam("table_id")],
				responses: { "204": { description: "gone" } },
			},
			get: {
				operationId: "table.get",
				parameters: [idParam("table_id")],
				responses: { "200": { content: json(tableSchema), description: "ok" }, "404": { description: "missing" } },
			},
		},
		"/v1/tables/{table_id}/exports": {
			get: {
				operationId: "export.list",
				parameters: [idParam("table_id")],
				responses: {
					"200": {
						content: json({ properties: { items: { items: exportSchema, type: "array" } }, type: "object" }),
						description: "ok",
					},
					"404": { description: "missing" },
				},
				"x-entity": { action: "list", identity: "id", name: "export" },
				"x-query": { grammar: "postgrest", sortable: ["created_at"] },
			},
		},
	},
} as unknown as OpenApiDocument

async function serve(): Promise<string> {
	const tables = new Map<string, { id: string; name: string }>()
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		let raw = ""
		for await (const chunk of req) raw += chunk
		const send = (status: number, value?: unknown) => {
			res.writeHead(status, value === undefined ? {} : { "content-type": "application/json" })
			res.end(value === undefined ? undefined : JSON.stringify(value))
		}
		if (url.pathname === "/openapi.json") return send(200, spec)
		if (url.pathname === "/v1/tables" && req.method === "POST") {
			const id = `t${tables.size + 1}`
			const table = { id, name: String((JSON.parse(raw || "{}") as { name?: unknown }).name ?? "") }
			tables.set(id, table)
			return send(201, table)
		}
		if (url.pathname === "/v1/tables") return send(200, { items: [...tables.values()] })
		const exports = /^\/v1\/tables\/([^/]+)\/exports$/.exec(url.pathname)
		if (exports !== null) {
			if (!tables.has(exports[1] ?? "")) return send(404, { error: "not_found" })
			const sort = url.searchParams.get("order")
			if (sort !== null && !/^created_at\.(asc|desc)/.test(sort)) return send(400, { error: "bad_sort" })
			return send(200, { items: [{ created_at: "2026-01-01T00:00:00Z", id: "e1" }] })
		}
		const item = /^\/v1\/tables\/([^/]+)$/.exec(url.pathname)
		if (item !== null) {
			const table = tables.get(item[1] ?? "")
			if (req.method === "DELETE") {
				tables.delete(item[1] ?? "")
				return send(204)
			}
			return table === undefined ? send(404, { error: "not_found" }) : send(200, table)
		}
		send(404, { error: "not_found" })
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("a listed entity with no create", () => {
	it("gets the parent its list path names", async () => {
		const url = await serve()
		const result = await run({
			baseUrl: url,
			principals: [{ headers: {}, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const missing = result.findings.filter((finding) => finding.detail.includes("no value for path parameter"))
		expect(missing.map((finding) => `${finding.check} ${finding.entity}`)).toEqual([])
		expect(
			result.client.transcript.some(
				(exchange) => /\/v1\/tables\/t\d+\/exports/.test(exchange.url) && exchange.status === 200,
			),
		).toBe(true)
	})
})
