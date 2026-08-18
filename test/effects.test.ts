import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
	bindAfterCreateEffects,
	bindCreatedScope,
	bindMissingPathParams,
	canFillPath,
	createdIdKeys,
	describeEffectHold,
	effectCardinality,
	effectHolds,
	findCreatedId,
	identityPathParam,
	mergeScope,
	scalarId,
} from "../src/runtime/effects.ts"
import { run } from "../src/runtime/run.ts"
import { driveWait } from "../src/runtime/wait.ts"
import { Client } from "../src/runtime/client.ts"
import { GapCollector, readEffects } from "../src/spec/extensions.ts"
import { buildModel } from "../src/spec/graph.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

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

describe("effectCardinality / effectHolds", () => {
	it("defaults to exact count 1 and describes both modes", () => {
		expect(effectCardinality({ entity: "table", op: "create" })).toEqual({ count: 1, mode: "exact" })
		expect(effectCardinality({ count: 3, entity: "row", op: "append" })).toEqual({ count: 3, mode: "exact" })
		expect(effectCardinality({ entity: "row", min: 1, op: "append" })).toEqual({ min: 1, mode: "min" })
		expect(describeEffectHold({ entity: "table", op: "create" })).toBe("create × 1")
		expect(describeEffectHold({ entity: "row", min: 2, op: "append" })).toBe("append ≥ 2")
	})

	it("holds exact and at-least create/append/delete, and forbids resize on update", () => {
		const create = { entity: "table", op: "create" as const }
		const appendMin = { entity: "row", min: 1, op: "append" as const }
		const del = { count: 2, entity: "row", op: "delete" as const }
		const delMin = { entity: "row", min: 1, op: "delete" as const }
		const update = { entity: "row", op: "update" as const }
		expect(effectHolds(create, 1, 1, 0)).toBe(true)
		expect(effectHolds(create, 2, 2, 0)).toBe(false)
		expect(effectHolds(appendMin, 5, 5, 0)).toBe(true)
		expect(effectHolds(appendMin, 0, 0, 0)).toBe(false)
		expect(effectHolds(del, -2, 0, 2)).toBe(true)
		expect(effectHolds(del, -1, 0, 1)).toBe(false)
		expect(effectHolds(delMin, -3, 0, 3)).toBe(true)
		expect(effectHolds(delMin, 0, 0, 0)).toBe(false)
		expect(effectHolds(update, 0, 0, 0)).toBe(true)
		expect(effectHolds(update, 1, 1, 0)).toBe(false)
		expect(effectHolds({ entity: "row", op: "replace" }, 0, 0, 0)).toBe(true)
	})
})

describe("bind created parent id", () => {
	it("reads conventional keys, nested objects, arrays, and scalars", () => {
		expect(scalarId("t1")).toBe("t1")
		expect(scalarId(7)).toBe("7")
		expect(scalarId("")).toBeUndefined()
		expect(scalarId(Number.NaN)).toBeUndefined()
		expect(scalarId(null)).toBeUndefined()
		expect(createdIdKeys("table", "id")).toEqual(["table_id", "id"])
		expect(createdIdKeys("table", "table_id")).toEqual(["table_id", "id"])
		expect(createdIdKeys("table", null)).toEqual(["table_id", "id"])
		expect(createdIdKeys("table", "")).toEqual(["table_id", "id"])
		expect(bindMissingPathParams(["table_id", "table_id"], {}, { table_id: "t" })).toEqual({ table_id: "t" })
		expect(findCreatedId({ table_id: "t1" }, ["table_id"])).toBe("t1")
		expect(findCreatedId({ id: 9 }, ["id"])).toBe("9")
		expect(findCreatedId({ data: { table: { id: "nested" } } }, ["id"])).toBe("nested")
		expect(findCreatedId({ items: [{ table_id: "from-array" }] }, ["table_id"])).toBe("from-array")
		expect(findCreatedId(null, ["id"])).toBeUndefined()
		expect(findCreatedId("x", ["id"])).toBeUndefined()
		expect(findCreatedId({ a: { b: { c: { d: { id: "too-deep" } } } } }, ["id"])).toBeUndefined()
		expect(findCreatedId([{ nope: 1 }], ["id"])).toBeUndefined()
	})

	it("binds table_id from the write body or the list delta", () => {
		const model = buildModel(nestedSpec())
		expect(identityPathParam(model, "table")).toBe("table_id")
		expect(identityPathParam(model, "missing")).toBe("missing_id")
		expect(bindCreatedScope(model, "table", { table_id: "t_body" })).toEqual({ table_id: "t_body" })
		expect(bindCreatedScope(model, "table", { id: "t_id" })).toEqual({ table_id: "t_id" })
		expect(bindCreatedScope(model, "table", {}, ["t_delta"])).toEqual({ table_id: "t_delta" })
		expect(bindCreatedScope(model, "table", {})).toEqual({})
		expect(bindCreatedScope(model, "ghost", { id: "g1" })).toEqual({ ghost_id: "g1" })
		expect(bindMissingPathParams(["project_id", "table_id"], { project_id: "p1" }, { table_id: "t9" })).toEqual({
			table_id: "t9",
		})
		expect(bindMissingPathParams(["project_id"], { project_id: "p1" }, { project_id: "other" })).toEqual({})
		expect(bindMissingPathParams(["table_id"], {}, { name: "n" })).toEqual({})
		expect(
			bindAfterCreateEffects(
				model,
				[
					{ entity: "table", op: "create" },
					{ entity: "row", min: 1, op: "append" },
				],
				{ table_id: "t_new" },
			),
		).toEqual({ table_id: "t_new" })
		expect(mergeScope({ project_id: "p1" }, { table_id: "t1" })).toEqual({ project_id: "p1", table_id: "t1" })
		expect(canFillPath("/v1/projects/{project_id}/tables/{table_id}/rows", { project_id: "p", table_id: "t" })).toBe(
			true,
		)
		expect(canFillPath("/v1/projects/{project_id}/tables/{table_id}/rows", { project_id: "p" })).toBe(false)
	})

	it("falls back to delete/update last param and conventional name", () => {
		const noRead: OpenApiDocument = {
			info: { title: "x", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/widgets": {
					get: {
						operationId: "widget.list",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "list", identity: "id", name: "widget" },
					},
				},
				"/v1/widgets/{widget_id}": {
					delete: {
						operationId: "widget.delete",
						parameters: [{ in: "path", name: "widget_id", required: true, schema: { type: "string" } }],
						responses: { "204": { description: "gone" } },
						"x-entity": { action: "delete", identity: "id", name: "widget" },
					},
				},
			},
		}
		const model = buildModel(noRead)
		expect(identityPathParam(model, "widget")).toBe("widget_id")

		const onlyUpdate: OpenApiDocument = {
			info: { title: "y", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/notes": {
					get: {
						operationId: "note.list",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "list", identity: "id", name: "note" },
					},
				},
				"/v1/notes/{note_id}": {
					patch: {
						operationId: "note.update",
						parameters: [{ in: "path", name: "note_id", required: true, schema: { type: "string" } }],
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "update", identity: "id", name: "note" },
					},
				},
			},
		}
		expect(identityPathParam(buildModel(onlyUpdate), "note")).toBe("note_id")

		const listOnly: OpenApiDocument = {
			info: { title: "z", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/tags": {
					get: {
						operationId: "tag.list",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "list", identity: "id", name: "tag" },
					},
					post: {
						operationId: "tag.create",
						responses: { "201": { description: "ok" } },
						"x-entity": { action: "create", identity: "id", name: "tag" },
					},
				},
			},
		}
		expect(identityPathParam(buildModel(listOnly), "tag")).toBe("tag_id")

		const itemId: OpenApiDocument = {
			info: { title: "id-param", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/items": {
					get: {
						operationId: "item.list",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "list", identity: "id", name: "item" },
					},
				},
				"/v1/items/{id}": {
					get: {
						operationId: "item.read",
						parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "read", identity: "id", name: "item" },
					},
				},
			},
		}
		const itemModel = buildModel(itemId)
		expect(identityPathParam(itemModel, "item")).toBe("id")
		expect(bindCreatedScope(itemModel, "item", { id: "i1" })).toEqual({ id: "i1", item_id: "i1" })
	})
})

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
		const client = new Client(server.url)
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
