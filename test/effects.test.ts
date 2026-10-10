import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
	applyActionBind,
	bindActionScope,
	bindAfterCreateEffects,
	bindCreatedScope,
	bindInstanceScope,
	bindMissingPathParams,
	nestedParamId,
	readActionBind,
	readBefore,
	valueAt,
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
		expect(bindInstanceScope(model, "table", "id", [{ id: "t_seed" }], { project_id: "p1" })).toEqual({
			project_id: "p1",
			table_id: "t_seed",
		})
		expect(bindInstanceScope(model, "table", "id", [{ id: "t_seed" }], { project_id: "p1", table_id: "kept" })).toEqual(
			{
				project_id: "p1",
				table_id: "kept",
			},
		)
		expect(bindInstanceScope(model, "table", "missing", [{ id: "from-id" }], { project_id: "p1" })).toEqual({
			project_id: "p1",
			table_id: "from-id",
		})
		expect(bindInstanceScope(model, "table", "missing", [{ table_id: "from-param" }], { project_id: "p1" })).toEqual({
			project_id: "p1",
			table_id: "from-param",
		})
		expect(bindInstanceScope(model, "table", "id", [{}, { id: "t2" }], { project_id: "p1" })).toEqual({
			project_id: "p1",
			table_id: "t2",
		})
		expect(bindInstanceScope(model, "table", "id", [{}], { project_id: "p1" })).toEqual({ project_id: "p1" })
		expect(readActionBind(null)).toBeNull()
		expect(readActionBind([])).toBeNull()
		expect(readActionBind({ path: { col_id: "$.columns_json[0].id" }, body: { order: 1 }, query: {} })).toEqual({
			path: { col_id: "$.columns_json[0].id" },
			body: {},
			query: {},
		})
		expect(readBefore("")).toBeUndefined()
		expect(readBefore("table.delete")).toBe("table.delete")
		expect(valueAt({ columns_json: [{ id: "c1" }, { id: "c2" }] }, "$.columns_json[*].id")).toEqual(["c1", "c2"])
		expect(valueAt({ columns_json: [{ id: "c1" }] }, "$.columns_json[0].id")).toBe("c1")
		expect(valueAt({ id: "nope" }, "$.missing")).toBeUndefined()
		expect(valueAt("nope", "$.id")).toBeUndefined()
		expect(nestedParamId({ columns_json: [{ id: "c1" }] }, "col_id")).toBe("c1")
		expect(nestedParamId({ col_id: "direct" }, "col_id")).toBe("direct")
		expect(nestedParamId({ name: "n" }, "slug")).toBeUndefined()
		expect(nestedParamId({ columns_json: [{}] }, "col_id")).toBeUndefined()
		const record = { columns_json: [{ id: "c1", name: "aa0" }] }
		expect(bindActionScope(["table_id", "col_id"], [record], { table_id: "t1" }, null, undefined)).toEqual({
			table_id: "t1",
			col_id: "c1",
		})
		expect(
			bindActionScope(
				["member_id"],
				[],
				{ member_id: "owner" },
				readActionBind({ path: { member_id: "before:$.id" } }),
				{ id: "mem_1" },
			),
		).toEqual({ member_id: "mem_1" })
		expect(
			bindActionScope(
				["member_id"],
				[],
				{ member_id: "owner" },
				readActionBind({ path: { member_id: "before:$.missing" } }),
				{},
			),
		).toEqual({ member_id: "owner" })
		expect(
			bindActionScope(["template_id"], [record], {}, readActionBind({ path: { template_id: "before:$.id" } }), {
				id: "tmpl_1",
			}),
		).toEqual({ template_id: "tmpl_1" })
		expect(bindActionScope(["col_id"], [{}], {}, null, undefined)).toEqual({})
		const applied = applyActionBind(
			readActionBind({
				body: { order: "$.columns_json[*].id" },
				query: { aggs: "aa0.count", names: "$.columns_json[*].name" },
			}),
			[record],
			undefined,
			{ order: ["generated"] },
		)
		expect(applied.body).toEqual({ order: ["c1"] })
		expect(applied.query).toEqual({ aggs: "aa0.count", names: "aa0" })
		expect(applyActionBind(null, [], undefined, undefined)).toEqual({ body: undefined, query: {} })
		expect(applyActionBind(readActionBind({ query: { n: "$.n" } }), [{ n: 2 }], undefined, undefined).query).toEqual({
			n: "2",
		})
		expect(
			bindActionScope(["col_id"], [record], {}, readActionBind({ path: { col_id: "$.nope" } }), undefined),
		).toEqual({
			col_id: "c1",
		})
		expect(valueAt({ a: "x" }, "$.a[0]")).toBeUndefined()
		expect(valueAt({ a: { 0: "c1" } }, "$.a[0]")).toBeUndefined()
		expect(valueAt({ id: "z" }, "$id")).toBe("z")
		expect(valueAt({ a: "x" }, "$.a[*]")).toEqual([])
		expect(canFillPath("/v1/{ghost_id}", { project_id: "p1" })).toBe(false)
		expect(canFillPath("/v1/{project_id}", { project_id: "p1" })).toBe(true)
		expect(nestedParamId({ columns_json: [{ id: "c1" }] }, "_id")).toBeUndefined()
		expect(nestedParamId({ cols: [{ id: "c9" }] }, "col_id")).toBe("c9")
		let deep: Record<string, unknown> = { columns_json: [{ id: "too-deep" }] }
		for (let i = 0; i < 8; i++) deep = { nest: deep }
		expect(nestedParamId(deep, "col_id")).toBeUndefined()
		expect(nestedParamId({ wrap: [{ columns_json: [{ id: "c3" }] }] }, "col_id")).toBe("c3")
		expect(
			applyActionBind(
				readActionBind({ body: { order: "$.id" }, query: { aggs: "$.name" } }),
				[{ id: "c1", name: "" }],
				undefined,
				undefined,
			),
		).toEqual({ body: undefined, query: {} })
		expect(
			applyActionBind(
				readActionBind({ query: { names: "$.columns_json[*].name" } }),
				[{ columns_json: [{ name: "" }, { name: "aa0" }] }],
				undefined,
				{},
			).query,
		).toEqual({ names: "aa0" })
		expect(
			bindActionScope(["template_id"], [], {}, readActionBind({ path: { template_id: "before:id" } }), { id: "x" }),
		).toEqual({})
		expect(
			bindActionScope(
				["col_id"],
				[record],
				{},
				readActionBind({ path: { col_id: "$.columns_json[*].id" } }),
				undefined,
			),
		).toEqual({ col_id: "c1" })
		expect(
			bindActionScope(
				["col_id"],
				[record],
				{},
				readActionBind({ path: { col_id: "$.columns_json[*].nope" } }),
				undefined,
			),
		).toEqual({ col_id: "c1" })
		expect(
			applyActionBind(readActionBind({ body: { name: "$.missing" } }), [record], undefined, { name: "old" }).body,
		).toEqual({ name: "old" })
		expect(
			applyActionBind(
				readActionBind({ query: { names: "$.columns_json[*].name", n: "$.n" } }),
				[{ columns_json: [{ name: "" }], n: Number.POSITIVE_INFINITY }],
				undefined,
				{},
			).query,
		).toEqual({})
		expect(nestedParamId({ columns_json: [null, [], { id: "c4" }] }, "col_id")).toBe("c4")
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
