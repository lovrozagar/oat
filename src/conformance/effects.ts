/**
 * Extract-shaped `x-effects`: one write creates a parent and appends a data-dependent child list.
 *
 * Nested observe must bind the new parent id (response `table_id` / identity, or the list delta).
 * `min` is at-least — empty child list fails, five rows pass. `count` + `min` is rejected at load.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { run } from "../runtime/run.ts"
import { buildModel } from "../spec/graph.ts"
import { GapCollector, readEffects } from "../spec/extensions.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import type { ParserResult } from "./suite.ts"

const TABLE = {
	properties: { id: { type: "string" }, name: { type: "string" }, table_id: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const ROW = {
	properties: { id: { type: "string" }, table_id: { type: "string" } },
	required: ["id", "table_id"],
	type: "object",
}

function extractSpec(): OpenApiDocument {
	return {
		info: { title: "extract-effects", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/tables": {
				get: {
					operationId: "table.list",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { tables: { items: TABLE, type: "array" } },
										required: ["tables"],
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
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { name: { type: "string" } },
									required: ["name"],
									type: "object",
								},
							},
						},
						required: true,
					},
					responses: {
						"201": { content: { "application/json": { schema: TABLE } }, description: "created" },
					},
					"x-entity": { action: "create", identity: "id", name: "table" },
				},
			},
			"/v1/projects/{project_id}/tables/{table_id}": {
				get: {
					operationId: "table.read",
					parameters: [
						{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": { content: { "application/json": { schema: TABLE } }, description: "ok" },
					},
					"x-entity": { action: "read", identity: "id", name: "table" },
				},
			},
			"/v1/projects/{project_id}/tables/{table_id}/rows": {
				get: {
					operationId: "row.list",
					parameters: [
						{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { rows: { items: ROW, type: "array" } },
										required: ["rows"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "row" },
				},
			},
			"/v1/projects/{project_id}/extract": {
				post: {
					operationId: "extract.once",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: TABLE } }, description: "ok" },
					},
					"x-effects": [
						{ entity: "table", op: "create" },
						{ entity: "row", min: 1, op: "append" },
					],
					"x-entity": { action: "action", identity: "id", name: "table" },
					"x-wait": {
						operationId: "row.list",
						pollIntervalMs: 40,
						timeoutMs: 800,
						until: "$.rows.0",
					},
				},
			},
		},
	} as OpenApiDocument
}

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

async function serveExtract(rowCount: number): Promise<{ close: () => Promise<void>; url: string }> {
	const spec = extractSpec()
	const tables = new Map<string, { id: string; name: string; table_id: string }>()
	const rows = new Map<string, Array<{ id: string; table_id: string }>>()
	let seq = 0

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)

			const list = /^\/v1\/projects\/([^/]+)\/tables$/.exec(url.pathname)
			if (list !== null && method === "GET") return send(res, 200, { tables: [...tables.values()] })
			if (list !== null && method === "POST") {
				const body = (await readJson(req)) as { name?: unknown }
				const id = `t_${String((seq += 1))}`
				const row = { id, name: typeof body?.name === "string" ? body.name : "n", table_id: id }
				tables.set(id, row)
				rows.set(id, [])
				return send(res, 201, row)
			}

			const item = /^\/v1\/projects\/([^/]+)\/tables\/([^/]+)$/.exec(url.pathname)
			if (item !== null && method === "GET") {
				const row = tables.get(decodeURIComponent(item[2] ?? ""))
				return row === undefined ? send(res, 404) : send(res, 200, row)
			}

			const rowList = /^\/v1\/projects\/([^/]+)\/tables\/([^/]+)\/rows$/.exec(url.pathname)
			if (rowList !== null && method === "GET") {
				const tableId = decodeURIComponent(rowList[2] ?? "")
				if (!tables.has(tableId)) return send(res, 404)
				return send(res, 200, { rows: rows.get(tableId) ?? [] })
			}

			const extract = /^\/v1\/projects\/([^/]+)\/extract$/.exec(url.pathname)
			if (extract !== null && method === "POST") {
				const id = `t_${String((seq += 1))}`
				const table = { id, name: "extracted", table_id: id }
				tables.set(id, table)
				const created: Array<{ id: string; table_id: string }> = []
				for (let i = 0; i < rowCount; i++) created.push({ id: `r_${id}_${String(i + 1)}`, table_id: id })
				rows.set(id, created)
				return send(res, 200, table)
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
		url: `http://127.0.0.1:${addr.port}`,
	}
}

function push(results: ParserResult[], name: string, why: string, ok: boolean, detail: string): void {
	results.push({ detail, name, ok, why })
}

async function runExtract(rowCount: number) {
	const server = await serveExtract(rowCount)
	try {
		return await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["table"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha", roots: { project_id: "p1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
	} finally {
		await server.close()
	}
}

export async function runEffectsSuite(): Promise<ParserResult[]> {
	const results: ParserResult[] = []

	const gaps = new GapCollector()
	const both = readEffects(
		{
			responses: {},
			"x-effects": [{ count: 1, entity: "row", min: 1, op: "append" }],
		} as never,
		"extract.once",
		gaps,
	)
	const model = buildModel(extractSpec())
	const extract = model.byOperationId.get("extract.once")
	push(
		results,
		"count and min together are rejected at load",
		"doctor / readEffects must not keep a contradictory item",
		both.length === 0 &&
			gaps.gaps.some((gap) => gap.tag === "x-effects" && gap.detail.includes("count and min")) &&
			extract !== undefined &&
			extract.effects.some((effect) => effect.entity === "row" && effect.min === 1 && effect.count === undefined),
		`read=${JSON.stringify(both)} gaps=${JSON.stringify(gaps.gaps)} modelled=${JSON.stringify(extract?.effects)}`,
	)

	try {
		const empty = await runExtract(0)
		const effectBug = empty.findings.find(
			(finding) => finding.check === "effects.declared-effect-occurs" && finding.verdict === "BACKEND_BUG",
		)
		push(
			results,
			"extract with an empty row list fails min: 1",
			"nested row list after table create must be observed",
			effectBug !== undefined && (effectBug.detail.includes("row") || effectBug.summary.includes("row")),
			effectBug === undefined
				? `no effect finding; findings=${empty.findings.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}`
				: effectBug.detail,
		)
	} catch (error) {
		push(
			results,
			"extract with an empty row list fails min: 1",
			"nested row list after table create must be observed",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const full = await runExtract(5)
		const effectBug = full.findings.find((finding) => finding.check === "effects.declared-effect-occurs")
		const waitBug = full.findings.find(
			(finding) => finding.check === "effects.side-effect-arrives" && finding.verdict === "BACKEND_BUG",
		)
		push(
			results,
			"extract with 5 rows passes min: 1",
			"bound table_id must fill the nested row list and x-wait",
			effectBug === undefined && waitBug === undefined,
			effectBug === undefined && waitBug === undefined
				? "no effect/wait findings"
				: `effects=${effectBug?.detail ?? "none"}; wait=${waitBug?.detail ?? "none"}`,
		)
	} catch (error) {
		push(
			results,
			"extract with 5 rows passes min: 1",
			"bound table_id must fill the nested row list and x-wait",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	return results
}
