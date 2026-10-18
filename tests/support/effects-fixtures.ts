import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Fixtures for the declared-effects tests: a local server per test built from small routes, the
 * nested project/table/row spec, and the table routes most of those servers share.
 */

export function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

/* Answers and marks the request handled, so a route reads as `return reply(...)`. */
export function reply(res: ServerResponse, status: number, body?: unknown): true {
	send(res, status, body)
	return true
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T
}

export type Listening = { close: () => Promise<void>; url: string }

/* Every server a test file opens, closed together after each test. */
export class Listeners {
	readonly #closers: Array<() => Promise<void>> = []

	async listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Listening> {
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
		this.#closers.push(handle.close)
		return handle
	}

	async closeAll(): Promise<void> {
		await Promise.all(this.#closers.splice(0).map((close) => close()))
	}
}

export type Exchange = { method: string; req: IncomingMessage; res: ServerResponse; url: URL }

/* One route: answers and returns true, or returns false to let the next route look. */
export type Route = (exchange: Exchange) => boolean | Promise<boolean>

async function dispatch(routes: readonly Route[], exchange: Exchange): Promise<void> {
	for (const route of routes) {
		if (await route(exchange)) return
	}
	send(exchange.res, 404)
}

/* A server that hands out `spec` at /v1/openapi/spec and tries `routes` in order, else 404. */
export function serve(listeners: Listeners, spec: OpenApiDocument, routes: readonly Route[]): Promise<Listening> {
	return listeners.listen((req, res) => {
		const exchange = {
			method: (req.method ?? "GET").toUpperCase(),
			req,
			res,
			url: new URL(req.url ?? "/", "http://127.0.0.1"),
		}
		if (exchange.url.pathname === "/v1/openapi/spec") return send(res, 200, spec)
		dispatch(routes, exchange).catch(() => send(res, 500))
	})
}

export function runTable(baseUrl: string): ReturnType<typeof run> {
	return run({
		baseUrl,
		cohortSize: 1,
		only: ["table"],
		principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots: { project_id: "p1" } }],
		seed: 1,
		spec: `${baseUrl}/v1/openapi/spec`,
	})
}

export function pathParam(name: string): Record<string, unknown> {
	return { in: "path", name, required: true, schema: { type: "string" } }
}

function pathParams(...names: string[]): Array<Record<string, unknown>> {
	return names.map(pathParam)
}

function ok(schema: unknown, description = "ok"): Record<string, unknown> {
	return { content: { "application/json": { schema } }, description }
}

function idName(): Record<string, unknown> {
	return { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
}

export function listOf(key: string, item: unknown): Record<string, unknown> {
	return { properties: { [key]: { items: item, type: "array" } }, type: "object" }
}

export function entity(action: string, name: string): Record<string, unknown> {
	return { action, identity: "id", name }
}

function tablesPath(): Record<string, unknown> {
	return {
		get: {
			operationId: "table.list",
			parameters: pathParams("project_id"),
			responses: { "200": ok(listOf("tables", idName())) },
			"x-entity": entity("list", "table"),
		},
		post: {
			operationId: "table.create",
			parameters: pathParams("project_id"),
			requestBody: {
				content: {
					"application/json": {
						schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
					},
				},
				required: true,
			},
			responses: { "201": ok(idName(), "created") },
			"x-entity": entity("create", "table"),
		},
	}
}

function tablePath(): Record<string, unknown> {
	return {
		delete: {
			operationId: "table.delete",
			parameters: pathParams("project_id", "table_id"),
			responses: { "204": { description: "gone" } },
			"x-entity": entity("delete", "table"),
		},
		get: {
			operationId: "table.read",
			parameters: pathParams("project_id", "table_id"),
			responses: { "200": ok(idName()) },
			"x-entity": entity("read", "table"),
		},
		patch: {
			operationId: "table.update",
			parameters: pathParams("project_id", "table_id"),
			requestBody: {
				content: {
					"application/json": {
						schema: { properties: { name: { type: "string" } }, type: "object" },
					},
				},
			},
			responses: { "200": ok(idName()) },
			"x-entity": entity("update", "table"),
		},
	}
}

function rowsPath(): Record<string, unknown> {
	return {
		get: {
			operationId: "row.list",
			parameters: pathParams("project_id", "table_id"),
			responses: { "200": ok(listOf("rows", { properties: { id: { type: "string" } }, type: "object" })) },
			"x-entity": entity("list", "row"),
		},
	}
}

function extractPath(): Record<string, unknown> {
	return {
		post: {
			operationId: "extract.once",
			parameters: pathParams("project_id"),
			responses: { "200": { description: "ok" } },
			"x-effects": [
				{ entity: "table", op: "create" },
				{ entity: "row", min: 1, op: "append" },
			],
			"x-entity": entity("action", "table"),
		},
	}
}

/* Projects own tables, tables own rows, and one action creates a table with its rows. */
export function nestedSpec(): OpenApiDocument {
	return {
		info: { title: "effects", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/tables": tablesPath(),
			"/v1/projects/{project_id}/tables/{table_id}": tablePath(),
			"/v1/projects/{project_id}/tables/{table_id}/rows": rowsPath(),
			"/v1/projects/{project_id}/extract": extractPath(),
		},
	} as OpenApiDocument
}

/* The nested spec without its extract action, ready for a test to add its own paths. */
export function pathsWithoutExtract(spec: OpenApiDocument): NonNullable<OpenApiDocument["paths"]> {
	delete spec.paths?.["/v1/projects/{project_id}/extract"]
	const paths = spec.paths
	if (paths === undefined) throw new Error("missing paths")
	return paths
}

type Paths = NonNullable<OpenApiDocument["paths"]>

function idList(key: string) {
	return {
		"200": {
			content: {
				"application/json": { schema: listOf(key, { properties: { id: { type: "string" } }, type: "object" }) },
			},
			description: "ok",
		},
	}
}

/* An organization entity reachable only by listing, with its member list. */
export function addOrganizations(paths: Paths): void {
	paths["/v1/organizations"] = {
		get: { operationId: "org.list", responses: idList("organizations"), "x-entity": entity("list", "organization") },
		post: {
			operationId: "org.create",
			responses: {
				"201": {
					description: "created",
					content: { "application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } } },
				},
			},
			"x-entity": entity("create", "organization"),
		},
	} as never
	paths["/v1/organizations/{organization_id}"] = {
		delete: {
			operationId: "org.delete",
			parameters: [pathParam("organization_id")],
			responses: { "204": { description: "gone" } },
			"x-entity": entity("delete", "organization"),
		},
	} as never
	paths["/v1/organizations/{organization_id}/members"] = {
		get: {
			operationId: "org.listMembers",
			parameters: [pathParam("organization_id")],
			responses: idList("members"),
			"x-entity": entity("list", "member"),
		},
	} as never
}

/* Member actions: one bound through an invite prelude, one whose prelude cannot run, one with no path. */
export function addMemberActions(paths: Paths): void {
	const update = { "x-effects": [{ entity: "member", op: "update" }] }
	paths["/v1/organizations/{organization_id}/invites"] = {
		post: {
			operationId: "org.inviteMember",
			parameters: [pathParam("organization_id")],
			responses: { "201": { description: "invited" } },
			"x-entity": entity("action", "organization"),
		},
	} as never
	paths["/v1/organizations/{organization_id}/members/{member_id}"] = {
		patch: {
			operationId: "org.updateMemberRole",
			parameters: [pathParam("organization_id"), pathParam("member_id")],
			responses: { "200": { description: "ok" } },
			"x-before": "org.inviteMember",
			"x-bind": { path: { member_id: "before:$.id" } },
			...update,
			"x-entity": entity("action", "member"),
		},
	} as never
	paths["/v1/ghost/{ghost_id}"] = memberAction("member.needsGhost", "ghost_id", {}) as never
	paths["/v1/organizations/{organization_id}/touch"] = memberAction("member.touch", "organization_id", {
		"x-before": "member.needsGhost",
		...update,
	}) as never
	paths["/v1/nope/{nope_id}"] = memberAction("member.orphan", "nope_id", update) as never
}

/* A member action at a path with one parameter, carrying `extra` declarations. */
function memberAction(operationId: string, param: string, extra: Record<string, unknown>): Record<string, unknown> {
	return {
		post: {
			operationId,
			parameters: [pathParam(param)],
			responses: { "200": { description: "ok" } },
			...extra,
			"x-entity": entity("action", "member"),
		},
	}
}

type Table = { id: string; name: string }

/* The tables and rows a table server holds, and the ids it hands out. */
export class TableWorld {
	readonly tables = new Map<string, Table>()
	readonly rows = new Map<string, Array<{ id: string }>>()
	#seq = 0

	nextId(): string {
		this.#seq += 1
		return `t_${String(this.#seq)}`
	}
}

const ITEM = /\/tables\/([^/]+)$/
const ROW_LIST = /\/tables\/([^/]+)\/rows$/

export function listTables(world: TableWorld): Route {
	return ({ method, res, url }) =>
		url.pathname.endsWith("/tables") && method === "GET" && reply(res, 200, { tables: [...world.tables.values()] })
}

/* Creates a table named by the request body, or "n" when `named` is false or the body has none. */
export function createTable(world: TableWorld, named = true): Route {
	return async ({ method, req, res, url }) => {
		if (!url.pathname.endsWith("/tables") || method !== "POST") return false
		const id = world.nextId()
		const name = named ? ((await readJson<{ name?: string }>(req)).name ?? "n") : "n"
		const row = { id, name }
		world.tables.set(id, row)
		if (named) world.rows.set(id, [])
		return reply(res, 201, row)
	}
}

export function readTable(world: TableWorld): Route {
	return ({ method, res, url }) => {
		const item = ITEM.exec(url.pathname)
		if (item === null || method !== "GET") return false
		const row = world.tables.get(item[1] ?? "")
		return row === undefined ? reply(res, 404) : reply(res, 200, row)
	}
}

/* Lists a known table's rows, and 404 for an unknown table; `onPoll` sees every listing. */
export function listRows(world: TableWorld, onPoll: () => void = () => {}): Route {
	return ({ method, res, url }) => {
		const rowList = ROW_LIST.exec(url.pathname)
		if (rowList === null || method !== "GET") return false
		onPoll()
		const tableId = rowList[1] ?? ""
		if (!world.tables.has(tableId)) return reply(res, 404)
		return reply(res, 200, { rows: world.rows.get(tableId) ?? [] })
	}
}

export function deleteTable(world: TableWorld): Route {
	return ({ method, res, url }) => {
		const item = ITEM.exec(url.pathname)
		if (item === null || method !== "DELETE") return false
		world.tables.delete(item[1] ?? "")
		return reply(res, 204)
	}
}

/* Answers a patch with the table as it is, or with `{}` when `echo` is false. */
export function patchTable(world: TableWorld, echo = true): Route {
	return ({ method, res, url }) => {
		const item = ITEM.exec(url.pathname)
		if (item === null || method !== "PATCH") return false
		return reply(res, 200, echo ? (world.tables.get(item[1] ?? "") ?? {}) : {})
	}
}

/* The action that makes a new table holding `rows`, answering with `answer(id)`. */
export function extract(world: TableWorld, rows: Array<{ id: string }>, answer: (id: string) => unknown): Route {
	return ({ method, res, url }) => {
		if (!url.pathname.endsWith("/extract") || method !== "POST") return false
		const id = world.nextId()
		world.tables.set(id, { id, name: "extracted" })
		world.rows.set(id, rows)
		return reply(res, 200, answer(id))
	}
}
