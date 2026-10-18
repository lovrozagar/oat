import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { mergeScope } from "../../src/runtime/effects/scope.ts"
import { run } from "../../src/runtime/run/index.ts"
import { driveWait } from "../../src/runtime/wait.ts"
import { Client } from "../../src/client/client.ts"
import { readEffects } from "../../src/spec/extensions/effects.ts"
import { GapCollector } from "../../src/spec/extensions/gaps.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

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

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	close: () => Promise<void>
	url: string
}> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	const handle = {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
	closers.push(handle.close)
	return handle
}

function nestedSpec(): OpenApiDocument {
	return {
		info: { title: "effects", version: "1" },
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
										properties: {
											tables: {
												items: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
												type: "array",
											},
										},
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
								schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
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
					"x-entity": { action: "create", identity: "id", name: "table" },
				},
			},
			"/v1/projects/{project_id}/tables/{table_id}": {
				delete: {
					operationId: "table.delete",
					parameters: [
						{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
					],
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", identity: "id", name: "table" },
				},
				get: {
					operationId: "table.read",
					parameters: [
						{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
					],
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
					"x-entity": { action: "read", identity: "id", name: "table" },
				},
				patch: {
					operationId: "table.update",
					parameters: [
						{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
					],
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { name: { type: "string" } }, type: "object" },
							},
						},
					},
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
					"x-entity": { action: "update", identity: "id", name: "table" },
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
										properties: {
											rows: {
												items: { properties: { id: { type: "string" } }, type: "object" },
												type: "array",
											},
										},
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
					responses: { "200": { description: "ok" } },
					"x-effects": [
						{ entity: "table", op: "create" },
						{ entity: "row", min: 1, op: "append" },
					],
					"x-entity": { action: "action", identity: "id", name: "table" },
				},
			},
		},
	} as OpenApiDocument
}

describe("readEffects", () => {
	it("copies min, skips non-objects, and rejects count+min", () => {
		expect(readEffects({ responses: {} })).toEqual([])
		expect(
			readEffects({
				responses: {},
				"x-effects": [null, "nope", { entity: "table" }, { entity: "table", op: "create", min: 1 }],
			} as never),
		).toEqual([{ entity: "table", min: 1, op: "create" }])
		const gaps = new GapCollector()
		expect(
			readEffects(
				{
					responses: {},
					"x-effects": [{ count: 1, entity: "row", min: 1, op: "append" }],
				} as never,
				"extract.once",
				gaps,
			),
		).toEqual([])
		expect(gaps.gaps[0]?.tag).toBe("x-effects")
		expect(gaps.gaps[0]?.detail).toMatch(/count and min/)
		expect(
			readEffects({
				responses: {},
				"x-effects": [{ count: Number.NaN, entity: "row", min: Number.POSITIVE_INFINITY, op: "append" }],
			} as never),
		).toEqual([{ entity: "row", op: "append" }])
		const noId = new GapCollector()
		readEffects(
			{ responses: {}, "x-effects": [{ count: 1, entity: "x", min: 2, op: "create" }] } as never,
			undefined,
			noId,
		)
		expect(noId.gaps[0]?.operationId).toBe("")
	})
})

describe("declared effects bind the nested list", () => {
	it("fails when the new table's row list is empty and passes when it has 5", async () => {
		const spec = nestedSpec()
		const runOnce = async (rowCount: number) => {
			const tables = new Map<string, { id: string; name: string }>()
			const rows = new Map<string, Array<{ id: string }>>()
			let seq = 0
			const server = await listen((req, res) => {
				void (async () => {
					const url = new URL(req.url ?? "/", "http://127.0.0.1")
					const method = (req.method ?? "GET").toUpperCase()
					if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
					if (url.pathname.endsWith("/tables") && method === "GET")
						return send(res, 200, { tables: [...tables.values()] })
					if (url.pathname.endsWith("/tables") && method === "POST") {
						const id = `t_${String((seq += 1))}`
						const chunks: Buffer[] = []
						for await (const chunk of req) chunks.push(chunk as Buffer)
						const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string }
						const row = { id, name: body.name ?? "n" }
						tables.set(id, row)
						rows.set(id, [])
						return send(res, 201, row)
					}
					const item = /\/tables\/([^/]+)$/.exec(url.pathname)
					if (item !== null && method === "GET" && !url.pathname.endsWith("/rows")) {
						const row = tables.get(item[1] ?? "")
						return row === undefined ? send(res, 404) : send(res, 200, row)
					}
					const rowList = /\/tables\/([^/]+)\/rows$/.exec(url.pathname)
					if (rowList !== null && method === "GET") {
						const tableId = rowList[1] ?? ""
						if (!tables.has(tableId)) return send(res, 404)
						return send(res, 200, { rows: rows.get(tableId) ?? [] })
					}
					if (url.pathname.endsWith("/extract") && method === "POST") {
						const id = `t_${String((seq += 1))}`
						tables.set(id, { id, name: "extracted" })
						const created = Array.from({ length: rowCount }, (_, i) => ({ id: `r_${String(i + 1)}` }))
						rows.set(id, created)
						return send(res, 200, { id, table_id: id, name: "extracted" })
					}
					if (item !== null && method === "DELETE") {
						tables.delete(item[1] ?? "")
						return send(res, 204)
					}
					if (item !== null && method === "PATCH") return send(res, 200, tables.get(item[1] ?? "") ?? {})
					return send(res, 404)
				})().catch(() => send(res, 500))
			})
			return run({
				baseUrl: server.url,
				cohortSize: 1,
				only: ["table"],
				principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
				seed: 1,
				spec: `${server.url}/v1/openapi/spec`,
			})
		}

		const empty = await runOnce(0)
		expect(
			empty.findings.some(
				(finding) => finding.check === "effects.declared-effect-occurs" && finding.verdict === "BACKEND_BUG",
			),
		).toBe(true)

		const full = await runOnce(5)
		expect(full.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	/* The check could not see the effect, so it reports a gap; the 500 itself is still a failure. */
	it("fails an action that answers with a server error, not only leaves its effect unverified", async () => {
		const spec = nestedSpec()
		const tables = new Map<string, { id: string; name: string }>()
		let seq = 0
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname.endsWith("/extract")) return send(res, 500, { error: "upstream unavailable" })
				if (url.pathname.endsWith("/tables") && method === "GET")
					return send(res, 200, { tables: [...tables.values()] })
				if (url.pathname.endsWith("/tables") && method === "POST") {
					const id = `t_${String((seq += 1))}`
					tables.set(id, { id, name: "n" })
					return send(res, 201, tables.get(id))
				}
				const item = /\/tables\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") {
					const row = tables.get(item[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				if (url.pathname.endsWith("/rows")) return send(res, 200, { rows: [] })
				if (item !== null && method === "DELETE") {
					tables.delete(item[1] ?? "")
					return send(res, 204)
				}
				if (item !== null && method === "PATCH") return send(res, 200, tables.get(item[1] ?? "") ?? {})
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["table"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const crashed = result.findings.filter(
			(f) => f.verdict === "BACKEND_BUG" && f.evidence.some((e) => e.url.endsWith("/extract") && e.status === 500),
		)
		expect(crashed.map((f) => f.check)).toContain("response.no-server-error")
		expect(result.scope.operations.find((op) => op.operationId === "extract.once")?.status).toBe("failed")
	})

	it("uses the bound id on x-wait after the write", async () => {
		const spec = nestedSpec()
		const extract = spec.paths?.["/v1/projects/{project_id}/extract"]?.post as Record<string, unknown>
		extract["x-wait"] = { operationId: "row.list", pollIntervalMs: 20, timeoutMs: 400, until: "$.rows.0" }
		let polls = 0
		const tables = new Map<string, { id: string; name: string }>()
		const rows = new Map<string, Array<{ id: string }>>()
		let seq = 0
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname.endsWith("/tables") && method === "GET")
					return send(res, 200, { tables: [...tables.values()] })
				if (url.pathname.endsWith("/tables") && method === "POST") {
					const id = `t_${String((seq += 1))}`
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string }
					tables.set(id, { id, name: body.name ?? "n" })
					rows.set(id, [])
					return send(res, 201, { id, name: body.name ?? "n" })
				}
				const item = /\/tables\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET" && !url.pathname.endsWith("/rows")) {
					const row = tables.get(item[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				const rowList = /\/tables\/([^/]+)\/rows$/.exec(url.pathname)
				if (rowList !== null && method === "GET") {
					polls += 1
					const tableId = rowList[1] ?? ""
					if (!tables.has(tableId)) return send(res, 404)
					return send(res, 200, { rows: rows.get(tableId) ?? [] })
				}
				if (url.pathname.endsWith("/extract") && method === "POST") {
					const id = `t_${String((seq += 1))}`
					tables.set(id, { id, name: "extracted" })
					rows.set(id, [{ id: "r_1" }])
					return send(res, 200, { table_id: id })
				}
				if (item !== null && method === "DELETE") {
					tables.delete(item[1] ?? "")
					return send(res, 204)
				}
				if (item !== null && method === "PATCH") return send(res, 200, {})
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["table"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(result.findings.filter((finding) => finding.check === "effects.side-effect-arrives")).toEqual([])
		expect(polls).toBeGreaterThan(0)
	})

	it("binds the created table from the list delta when the write body has no id", async () => {
		const spec = nestedSpec()
		const tables = new Map<string, { id: string; name: string }>()
		const rows = new Map<string, Array<{ id: string }>>()
		let seq = 0
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname.endsWith("/tables") && method === "GET")
					return send(res, 200, { tables: [...tables.values()] })
				if (url.pathname.endsWith("/tables") && method === "POST") {
					const id = `t_${String((seq += 1))}`
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string }
					tables.set(id, { id, name: body.name ?? "n" })
					rows.set(id, [])
					return send(res, 201, { id, name: body.name ?? "n" })
				}
				const item = /\/tables\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET" && !url.pathname.endsWith("/rows")) {
					const row = tables.get(item[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				const rowList = /\/tables\/([^/]+)\/rows$/.exec(url.pathname)
				if (rowList !== null && method === "GET") {
					const tableId = rowList[1] ?? ""
					if (!tables.has(tableId)) return send(res, 404)
					return send(res, 200, { rows: rows.get(tableId) ?? [] })
				}
				if (url.pathname.endsWith("/extract") && method === "POST") {
					const id = `t_${String((seq += 1))}`
					tables.set(id, { id, name: "extracted" })
					rows.set(id, [{ id: "r_1" }, { id: "r_2" }])
					return send(res, 200, { accepted: true })
				}
				if (item !== null && method === "DELETE") {
					tables.delete(item[1] ?? "")
					return send(res, 204)
				}
				if (item !== null && method === "PATCH") return send(res, 200, {})
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["table"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})
})

describe("action on a seeded instance", () => {
	it("calls an action whose path needs the seeded table id", async () => {
		const spec = nestedSpec()
		delete spec.paths?.["/v1/projects/{project_id}/extract"]
		const paths = spec.paths
		if (paths === undefined) throw new Error("missing paths")
		paths["/v1/projects/{project_id}/tables/{table_id}/duplicate"] = {
			post: {
				operationId: "table.duplicate",
				parameters: [
					{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
					{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
				],
				responses: { "201": { description: "created" } },
				"x-effects": [{ entity: "table", op: "create" }],
				"x-entity": { action: "action", identity: "id", name: "table" },
			},
		} as never
		const tables = new Map<string, { id: string; name: string }>()
		let seq = 0
		const duplicated: string[] = []
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname.endsWith("/tables") && method === "GET")
					return send(res, 200, { tables: [...tables.values()] })
				if (url.pathname.endsWith("/tables") && method === "POST") {
					const id = `t_${String((seq += 1))}`
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string }
					tables.set(id, { id, name: body.name ?? "n" })
					return send(res, 201, { id, name: body.name ?? "n" })
				}
				const copy = /\/tables\/([^/]+)\/duplicate$/.exec(url.pathname)
				if (copy !== null && method === "POST") {
					const source = copy[1] ?? ""
					duplicated.push(source)
					if (!tables.has(source)) return send(res, 404)
					const id = `t_${String((seq += 1))}`
					tables.set(id, { id, name: "copy" })
					return send(res, 201, { id, name: "copy" })
				}
				const item = /\/tables\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") {
					const row = tables.get(item[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				if (item !== null && method === "DELETE") {
					tables.delete(item[1] ?? "")
					return send(res, 204)
				}
				if (item !== null && method === "PATCH") return send(res, 200, tables.get(item[1] ?? "") ?? {})
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["table"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(duplicated.length).toBeGreaterThan(0)
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	it("binds a nested column id, overlays the body, and runs x-before first", async () => {
		const spec = nestedSpec()
		delete spec.paths?.["/v1/projects/{project_id}/extract"]
		const paths = spec.paths
		if (paths === undefined) throw new Error("missing paths")
		paths["/v1/projects/{project_id}/tables/{table_id}/columns/{col_id}"] = {
			patch: {
				operationId: "column.update",
				parameters: [
					{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
					{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
					{ in: "path", name: "col_id", required: true, schema: { type: "string" } },
				],
				requestBody: {
					content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
				},
				responses: { "200": { description: "ok" } },
				"x-before": "column.add",
				"x-bind": { path: { col_id: "$.columns_json[0].id" }, body: { name: "kept" } },
				"x-effects": [{ entity: "table", op: "update" }],
				"x-entity": { action: "action", identity: "id", name: "table" },
			},
		} as never
		paths["/v1/projects/{project_id}/tables/{table_id}/columns"] = {
			post: {
				operationId: "column.add",
				parameters: [
					{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
					{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
				],
				responses: { "200": { description: "ok" } },
				"x-entity": { action: "action", identity: "id", name: "table" },
			},
		} as never
		const seen: string[] = []
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname.endsWith("/tables") && method === "GET")
					return send(res, 200, { tables: [{ id: "t1", columns_json: [{ id: "c1" }] }] })
				if (url.pathname.endsWith("/tables") && method === "POST")
					return send(res, 201, { id: "t1", columns_json: [{ id: "c1", name: "aa0" }] })
				if (url.pathname.endsWith("/columns") && method === "POST") {
					seen.push("add")
					return send(res, 200, { id: "t1" })
				}
				const update = /\/tables\/([^/]+)\/columns\/([^/]+)$/.exec(url.pathname)
				if (update !== null && method === "PATCH") {
					seen.push(`${update[1]}:${update[2]}`)
					return send(res, 200, { id: "t1" })
				}
				const item = /\/tables\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") return send(res, 200, { id: item[1] })
				if (item !== null && method === "DELETE") return send(res, 204)
				if (item !== null && method === "PATCH") return send(res, 200, { id: item[1] })
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["table"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(seen[0]).toBe("add")
		expect(seen).toContain("t1:c1")
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	it("binds from the instance as it is now, after another action changed it", async () => {
		const spec = nestedSpec()
		delete spec.paths?.["/v1/projects/{project_id}/extract"]
		const paths = spec.paths
		if (paths === undefined) throw new Error("missing paths")
		const tableParams = [
			{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
			{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
		]
		paths["/v1/projects/{project_id}/tables/{table_id}/columns"] = {
			post: {
				operationId: "column.add",
				parameters: tableParams,
				responses: { "200": { description: "ok" } },
				"x-effects": [{ entity: "table", op: "update" }],
				"x-entity": { action: "action", identity: "id", name: "table" },
			},
		} as never
		paths["/v1/projects/{project_id}/tables/{table_id}/columns/order"] = {
			put: {
				operationId: "column.reorder",
				parameters: tableParams,
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: { order: { items: { type: "string" }, type: "array" } },
								required: ["order"],
								type: "object",
							},
						},
					},
				},
				responses: { "200": { description: "ok" }, "400": { description: "not every column" } },
				"x-bind": { body: { order: "$.columns_json[*].id" } },
				"x-effects": [{ entity: "table", op: "update" }],
				"x-entity": { action: "action", identity: "id", name: "table" },
			},
		} as never
		const columns = new Map<string, string[]>()
		let seq = 0
		const orders: string[][] = []
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const row = (id: string) => ({ columns_json: (columns.get(id) ?? []).map((c) => ({ id: c })), id })
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname.endsWith("/tables") && method === "GET")
					return send(res, 200, { tables: [...columns.keys()].map(row) })
				if (url.pathname.endsWith("/tables") && method === "POST") {
					const id = `t${String((seq += 1))}`
					columns.set(id, ["c1"])
					return send(res, 201, row(id))
				}
				const add = /\/tables\/([^/]+)\/columns$/.exec(url.pathname)
				if (add !== null && method === "POST") {
					const id = add[1] ?? ""
					columns.get(id)?.push(`c${String((seq += 1))}`)
					return send(res, 200, row(id))
				}
				const reorder = /\/tables\/([^/]+)\/columns\/order$/.exec(url.pathname)
				if (reorder !== null && method === "PUT") {
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					const order = (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { order?: string[] }).order ?? []
					orders.push(order)
					const have = columns.get(reorder[1] ?? "") ?? []
					if ([...order].sort().join() !== [...have].sort().join()) return send(res, 400, { error: "not every column" })
					return send(res, 200, row(reorder[1] ?? ""))
				}
				const item = /\/tables\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") {
					return columns.has(item[1] ?? "") ? send(res, 200, row(item[1] ?? "")) : send(res, 404)
				}
				if (item !== null && method === "DELETE") {
					columns.delete(item[1] ?? "")
					return send(res, 204)
				}
				if (item !== null && method === "PATCH") return send(res, 200, row(item[1] ?? ""))
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["table"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(orders.length).toBeGreaterThan(0)
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	it("removes what an x-before prelude created through an invite", async () => {
		const member = { properties: { id: { type: "string" }, role: { type: "string" } }, type: "object" }
		const params = [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }]
		const memberParams = [...params, { in: "path", name: "member_id", required: true, schema: { type: "string" } }]
		const spec = {
			info: { title: "prelude-invite", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/orgs/{org_id}/members": {
					get: {
						operationId: "member.list",
						parameters: params,
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: {
											properties: { members: { items: member, type: "array" } },
											required: ["members"],
											type: "object",
										},
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "list", identity: "id", name: "member" },
					},
					post: {
						operationId: "member.invite",
						parameters: params,
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
								},
							},
						},
						responses: { "201": { content: { "application/json": { schema: member } }, description: "invited" } },
						"x-entity": { action: "create", identity: "id", name: "member" },
						"x-invite": {
							accept: "member.accept",
							granteeField: "email",
							invite: "member.invite",
							revoke: "member.remove",
						},
					},
				},
				"/v1/orgs/{org_id}/members/{member_id}": {
					delete: {
						operationId: "member.remove",
						parameters: memberParams,
						responses: { "200": { description: "removed" } },
						"x-entity": { action: "delete", identity: "id", name: "member" },
					},
					patch: {
						operationId: "member.setRole",
						parameters: memberParams,
						requestBody: {
							content: {
								"application/json": { schema: { properties: { role: { type: "string" } }, type: "object" } },
							},
						},
						responses: { "200": { content: { "application/json": { schema: member } }, description: "ok" } },
						"x-before": "member.invite",
						"x-bind": { path: { member_id: "before:$.id" } },
						"x-effects": [{ entity: "member", op: "update" }],
						"x-entity": { action: "action", identity: "id", name: "member" },
					},
				},
				"/v1/invites/{token}/accept": {
					post: {
						operationId: "member.accept",
						parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
						responses: { "200": { description: "accepted" } },
					},
				},
			},
		} as unknown as OpenApiDocument
		const members = new Map<string, { id: string; role: string }>([["m_owner", { id: "m_owner", role: "owner" }]])
		let seq = 0
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname.endsWith("/members") && method === "GET")
					return send(res, 200, { members: [...members.values()] })
				if (url.pathname.endsWith("/members") && method === "POST") {
					const id = `m_${String((seq += 1))}`
					members.set(id, { id, role: "member" })
					return send(res, 201, members.get(id))
				}
				const item = /\/members\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "DELETE") {
					members.delete(item[1] ?? "")
					return send(res, 200, {})
				}
				if (item !== null && method === "PATCH") return send(res, 200, members.get(item[1] ?? "") ?? {})
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		await run({
			baseUrl: server.url,
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { org_id: "o1" } }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(seq).toBeGreaterThan(0)
		expect([...members.keys()]).toEqual(["m_owner"])
	})

	it("seeds a list-only entity and reports a coverage gap when a path stays empty", async () => {
		const spec = nestedSpec()
		const paths = spec.paths
		if (paths === undefined) throw new Error("missing paths")
		paths["/v1/organizations"] = {
			get: {
				operationId: "org.list",
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										organizations: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
									},
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "organization" },
			},
			post: {
				operationId: "org.create",
				responses: {
					"201": {
						description: "created",
						content: { "application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } } },
					},
				},
				"x-entity": { action: "create", identity: "id", name: "organization" },
			},
		} as never
		paths["/v1/organizations/{organization_id}"] = {
			delete: {
				operationId: "org.delete",
				parameters: [{ in: "path", name: "organization_id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "gone" } },
				"x-entity": { action: "delete", identity: "id", name: "organization" },
			},
		} as never
		paths["/v1/organizations/{organization_id}/members"] = {
			get: {
				operationId: "org.listMembers",
				parameters: [{ in: "path", name: "organization_id", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										members: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
									},
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "member" },
			},
		} as never
		paths["/v1/organizations/{organization_id}/invites"] = {
			post: {
				operationId: "org.inviteMember",
				parameters: [{ in: "path", name: "organization_id", required: true, schema: { type: "string" } }],
				responses: { "201": { description: "invited" } },
				"x-entity": { action: "action", identity: "id", name: "organization" },
			},
		} as never
		paths["/v1/organizations/{organization_id}/members/{member_id}"] = {
			patch: {
				operationId: "org.updateMemberRole",
				parameters: [
					{ in: "path", name: "organization_id", required: true, schema: { type: "string" } },
					{ in: "path", name: "member_id", required: true, schema: { type: "string" } },
				],
				responses: { "200": { description: "ok" } },
				"x-before": "org.inviteMember",
				"x-bind": { path: { member_id: "before:$.id" } },
				"x-effects": [{ entity: "member", op: "update" }],
				"x-entity": { action: "action", identity: "id", name: "member" },
			},
		} as never
		paths["/v1/ghost/{ghost_id}"] = {
			post: {
				operationId: "member.needsGhost",
				parameters: [{ in: "path", name: "ghost_id", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
				"x-entity": { action: "action", identity: "id", name: "member" },
			},
		} as never
		paths["/v1/organizations/{organization_id}/touch"] = {
			post: {
				operationId: "member.touch",
				parameters: [{ in: "path", name: "organization_id", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
				"x-before": "member.needsGhost",
				"x-effects": [{ entity: "member", op: "update" }],
				"x-entity": { action: "action", identity: "id", name: "member" },
			},
		} as never
		paths["/v1/nope/{nope_id}"] = {
			post: {
				operationId: "member.orphan",
				parameters: [{ in: "path", name: "nope_id", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
				"x-effects": [{ entity: "member", op: "update" }],
				"x-entity": { action: "action", identity: "id", name: "member" },
			},
		} as never
		const seen: string[] = []
		const members: Array<{ id: string }> = []
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
				if (url.pathname === "/v1/organizations" && method === "POST") return send(res, 201, { id: "org_1" })
				if (url.pathname === "/v1/organizations" && method === "GET")
					return send(res, 200, { organizations: [{ id: "org_1" }] })
				if (url.pathname === "/v1/organizations/org_1" && method === "DELETE") return send(res, 204)
				if (url.pathname.endsWith("/members") && method === "GET") return send(res, 200, { members })
				if (url.pathname.endsWith("/invites") && method === "POST") {
					seen.push("invite")
					members.push({ id: "mem_1" })
					return send(res, 201, { id: "mem_1" })
				}
				if (url.pathname.endsWith("/members/mem_1") && method === "PATCH") {
					seen.push("role")
					return send(res, 200, { id: "mem_1" })
				}
				return send(res, 404)
			})().catch(() => send(res, 500))
		})
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			only: ["member"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: {} }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(seen).toEqual(["invite", "role"])
		const gaps = result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")
		expect(gaps.map((finding) => finding.summary).sort()).toEqual([
			"member.orphan could not be invoked",
			'member.touch could not run x-before "member.needsGhost"',
		])
	})
})

describe("driveWait with a bound scope", () => {
	it("fills the poll path from the bound parent id", async () => {
		const spec = nestedSpec()
		const server = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname.endsWith("/rows")) return send(res, 200, { rows: [{ id: "r1" }] })
			return send(res, 404)
		})
		const model = buildModel(spec)
		const pollOp = model.byOperationId.get("row.list")
		if (pollOp === undefined) throw new Error("missing row.list")
		const client = new Client({ baseUrl: server.url, redactor: new Redactor() })
		const unbound = await driveWait({
			client,
			headers: () => ({}),
			pollOp,
			record: { table_id: "t1" },
			scope: { project_id: "p1" },
			spec: { operationId: "row.list", pollIntervalMs: 10, timeoutMs: 30 },
			writeOpId: "extract.once",
		})
		expect(unbound.timedOut).toBe(true)
		expect(unbound.polls).toBe(0)

		const bound = await driveWait({
			client,
			headers: () => ({}),
			pollOp,
			record: { table_id: "t1" },
			scope: mergeScope({ project_id: "p1" }, { table_id: "t1" }),
			spec: { operationId: "row.list", pollIntervalMs: 10, timeoutMs: 200, until: "$.rows.0" },
			writeOpId: "extract.once",
		})
		expect(bound.timedOut).toBe(false)
	})
})
