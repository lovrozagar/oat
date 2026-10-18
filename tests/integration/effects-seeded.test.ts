import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import {
	addMemberActions,
	addOrganizations,
	createTable,
	deleteTable,
	entity,
	type Exchange,
	Listeners,
	listTables,
	nestedSpec,
	pathParam,
	pathsWithoutExtract,
	patchTable,
	readJson,
	readTable,
	reply,
	type Route,
	runTable,
	serve,
	TableWorld,
} from "../support/effects-fixtures.ts"

const listeners = new Listeners()

afterEach(async () => {
	await listeners.closeAll()
})

type Paths = NonNullable<OpenApiDocument["paths"]>

function addDuplicate(paths: Paths): void {
	paths["/v1/projects/{project_id}/tables/{table_id}/duplicate"] = {
		post: {
			operationId: "table.duplicate",
			parameters: [pathParam("project_id"), pathParam("table_id")],
			responses: { "201": { description: "created" } },
			"x-effects": [{ entity: "table", op: "create" }],
			"x-entity": entity("action", "table"),
		},
	} as never
}

/* Copies the table its path names, recording each source asked for, and 404 for an unknown one. */
function duplicateTable(world: TableWorld, duplicated: string[]): Route {
	return ({ method, res, url }) => {
		const copy = /\/tables\/([^/]+)\/duplicate$/.exec(url.pathname)
		if (copy === null || method !== "POST") return false
		const source = copy[1] ?? ""
		duplicated.push(source)
		if (!world.tables.has(source)) return reply(res, 404)
		const id = world.nextId()
		world.tables.set(id, { id, name: "copy" })
		return reply(res, 201, { id, name: "copy" })
	}
}

function duplicateRoutes(world: TableWorld, duplicated: string[]): Route[] {
	return [
		listTables(world),
		createTable(world),
		duplicateTable(world, duplicated),
		readTable(world),
		deleteTable(world),
		patchTable(world),
	]
}

function addColumnUpdate(paths: Paths): void {
	paths["/v1/projects/{project_id}/tables/{table_id}/columns/{col_id}"] = {
		patch: {
			operationId: "column.update",
			parameters: [pathParam("project_id"), pathParam("table_id"), pathParam("col_id")],
			requestBody: {
				content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
			},
			responses: { "200": { description: "ok" } },
			"x-before": "column.add",
			"x-bind": { path: { col_id: "$.columns_json[0].id" }, body: { name: "kept" } },
			"x-effects": [{ entity: "table", op: "update" }],
			"x-entity": entity("action", "table"),
		},
	} as never
	paths["/v1/projects/{project_id}/tables/{table_id}/columns"] = {
		post: {
			operationId: "column.add",
			parameters: [pathParam("project_id"), pathParam("table_id")],
			responses: { "200": { description: "ok" } },
			"x-entity": entity("action", "table"),
		},
	} as never
}

/* One table t1 with one column c1; `seen` records the column add and each column update. */
function columnRoutes(seen: string[]): Route[] {
	return [
		({ method, res, url }) =>
			url.pathname.endsWith("/tables") &&
			method === "GET" &&
			reply(res, 200, { tables: [{ id: "t1", columns_json: [{ id: "c1" }] }] }),
		({ method, res, url }) =>
			url.pathname.endsWith("/tables") &&
			method === "POST" &&
			reply(res, 201, { id: "t1", columns_json: [{ id: "c1", name: "aa0" }] }),
		({ method, res, url }) => {
			if (!url.pathname.endsWith("/columns") || method !== "POST") return false
			seen.push("add")
			return reply(res, 200, { id: "t1" })
		},
		({ method, res, url }) => {
			const update = /\/tables\/([^/]+)\/columns\/([^/]+)$/.exec(url.pathname)
			if (update === null || method !== "PATCH") return false
			seen.push(`${update[1]}:${update[2]}`)
			return reply(res, 200, { id: "t1" })
		},
		({ method, res, url }) => {
			const item = /\/tables\/([^/]+)$/.exec(url.pathname)
			if (item === null) return false
			if (method === "DELETE") return reply(res, 204)
			return (method === "GET" || method === "PATCH") && reply(res, 200, { id: item[1] })
		},
	]
}

function addReorder(paths: Paths): void {
	const tableParams = [pathParam("project_id"), pathParam("table_id")]
	paths["/v1/projects/{project_id}/tables/{table_id}/columns"] = {
		post: {
			operationId: "column.add",
			parameters: tableParams,
			responses: { "200": { description: "ok" } },
			"x-effects": [{ entity: "table", op: "update" }],
			"x-entity": entity("action", "table"),
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
			"x-entity": entity("action", "table"),
		},
	} as never
}

/* Tables and their column ids; a reorder must name every column, and each order asked is kept. */
class ColumnWorld {
	readonly columns = new Map<string, string[]>()
	readonly orders: string[][] = []
	#seq = 0

	next(): string {
		this.#seq += 1
		return String(this.#seq)
	}

	row(id: string) {
		return { columns_json: (this.columns.get(id) ?? []).map((c) => ({ id: c })), id }
	}
}

async function reorder(world: ColumnWorld, { method, req, res, url }: Exchange): Promise<boolean> {
	const match = /\/tables\/([^/]+)\/columns\/order$/.exec(url.pathname)
	if (match === null || method !== "PUT") return false
	const order = (await readJson<{ order?: string[] }>(req)).order ?? []
	world.orders.push(order)
	const have = world.columns.get(match[1] ?? "") ?? []
	if ([...order].sort().join() !== [...have].sort().join()) return reply(res, 400, { error: "not every column" })
	return reply(res, 200, world.row(match[1] ?? ""))
}

function columnTable(world: ColumnWorld, { method, res, url }: Exchange): boolean {
	const item = /\/tables\/([^/]+)$/.exec(url.pathname)
	if (item === null) return false
	const id = item[1] ?? ""
	if (method === "GET") return world.columns.has(id) ? reply(res, 200, world.row(id)) : reply(res, 404)
	if (method === "DELETE") {
		world.columns.delete(id)
		return reply(res, 204)
	}
	return method === "PATCH" && reply(res, 200, world.row(id))
}

function reorderRoutes(world: ColumnWorld): Route[] {
	return [
		({ method, res, url }) =>
			url.pathname.endsWith("/tables") &&
			method === "GET" &&
			reply(res, 200, { tables: [...world.columns.keys()].map((id) => world.row(id)) }),
		({ method, res, url }) => {
			if (!url.pathname.endsWith("/tables") || method !== "POST") return false
			const id = `t${world.next()}`
			world.columns.set(id, ["c1"])
			return reply(res, 201, world.row(id))
		},
		({ method, res, url }) => {
			const add = /\/tables\/([^/]+)\/columns$/.exec(url.pathname)
			if (add === null || method !== "POST") return false
			const id = add[1] ?? ""
			world.columns.get(id)?.push(`c${world.next()}`)
			return reply(res, 200, world.row(id))
		},
		(exchange) => reorder(world, exchange),
		(exchange) => columnTable(world, exchange),
	]
}

function memberSchema() {
	return { properties: { id: { type: "string" }, role: { type: "string" } }, type: "object" }
}

function inviteMembersPath(params: unknown[]) {
	return {
		get: {
			operationId: "member.list",
			parameters: params,
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: {
								properties: { members: { items: memberSchema(), type: "array" } },
								required: ["members"],
								type: "object",
							},
						},
					},
					description: "ok",
				},
			},
			"x-entity": entity("list", "member"),
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
			responses: { "201": { content: { "application/json": { schema: memberSchema() } }, description: "invited" } },
			"x-entity": entity("create", "member"),
			"x-invite": { accept: "member.accept", granteeField: "email", invite: "member.invite", revoke: "member.remove" },
		},
	}
}

function inviteMemberPath(memberParams: unknown[]) {
	return {
		delete: {
			operationId: "member.remove",
			parameters: memberParams,
			responses: { "200": { description: "removed" } },
			"x-entity": entity("delete", "member"),
		},
		patch: {
			operationId: "member.setRole",
			parameters: memberParams,
			requestBody: {
				content: { "application/json": { schema: { properties: { role: { type: "string" } }, type: "object" } } },
			},
			responses: { "200": { content: { "application/json": { schema: memberSchema() } }, description: "ok" } },
			"x-before": "member.invite",
			"x-bind": { path: { member_id: "before:$.id" } },
			"x-effects": [{ entity: "member", op: "update" }],
			"x-entity": entity("action", "member"),
		},
	}
}

/* Members invited and removed; setting a role first invites the member it binds. */
function preludeInviteSpec(): OpenApiDocument {
	const params = [pathParam("org_id")]
	return {
		info: { title: "prelude-invite", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/members": inviteMembersPath(params),
			"/v1/orgs/{org_id}/members/{member_id}": inviteMemberPath([...params, pathParam("member_id")]),
			"/v1/invites/{token}/accept": {
				post: {
					operationId: "member.accept",
					parameters: [pathParam("token")],
					responses: { "200": { description: "accepted" } },
				},
			},
		},
	} as unknown as OpenApiDocument
}

class MemberWorld {
	readonly members = new Map<string, { id: string; role: string }>([["m_owner", { id: "m_owner", role: "owner" }]])
	invited = 0
}

function memberRoutes(world: MemberWorld): Route[] {
	return [
		({ method, res, url }) =>
			url.pathname.endsWith("/members") &&
			method === "GET" &&
			reply(res, 200, { members: [...world.members.values()] }),
		({ method, res, url }) => {
			if (!url.pathname.endsWith("/members") || method !== "POST") return false
			const id = `m_${String((world.invited += 1))}`
			world.members.set(id, { id, role: "member" })
			return reply(res, 201, world.members.get(id))
		},
		({ method, res, url }) => {
			const item = /\/members\/([^/]+)$/.exec(url.pathname)
			if (item === null) return false
			if (method === "DELETE") {
				world.members.delete(item[1] ?? "")
				return reply(res, 200, {})
			}
			return method === "PATCH" && reply(res, 200, world.members.get(item[1] ?? "") ?? {})
		},
	]
}

function organizationRoutes(seen: string[], members: Array<{ id: string }>): Route[] {
	return [
		({ method, res, url }) =>
			url.pathname === "/v1/organizations" && method === "POST" && reply(res, 201, { id: "org_1" }),
		({ method, res, url }) =>
			url.pathname === "/v1/organizations" && method === "GET" && reply(res, 200, { organizations: [{ id: "org_1" }] }),
		({ method, res, url }) => url.pathname === "/v1/organizations/org_1" && method === "DELETE" && reply(res, 204),
		({ method, res, url }) => url.pathname.endsWith("/members") && method === "GET" && reply(res, 200, { members }),
		({ method, res, url }) => {
			if (!url.pathname.endsWith("/invites") || method !== "POST") return false
			seen.push("invite")
			members.push({ id: "mem_1" })
			return reply(res, 201, { id: "mem_1" })
		},
		({ method, res, url }) => {
			if (!url.pathname.endsWith("/members/mem_1") || method !== "PATCH") return false
			seen.push("role")
			return reply(res, 200, { id: "mem_1" })
		},
	]
}

/* A run as one principal with `roots`, narrowed as `options` asks. */
function runAs(baseUrl: string, options: { cohortSize?: number; only?: string[]; roots: Record<string, string> }) {
	const { roots, ...narrowing } = options
	return run({
		baseUrl,
		...narrowing,
		principals: [{ headers: { authorization: "Bearer t" }, id: "a", roots }],
		seed: 1,
		spec: `${baseUrl}/v1/openapi/spec`,
	})
}

describe("action on a seeded instance", () => {
	it("calls an action whose path needs the seeded table id", async () => {
		const spec = nestedSpec()
		addDuplicate(pathsWithoutExtract(spec))
		const world = new TableWorld()
		const duplicated: string[] = []
		const server = await serve(listeners, spec, duplicateRoutes(world, duplicated))
		const result = await runTable(server.url)
		expect(duplicated.length).toBeGreaterThan(0)
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	it("binds a nested column id, overlays the body, and runs x-before first", async () => {
		const spec = nestedSpec()
		addColumnUpdate(pathsWithoutExtract(spec))
		const seen: string[] = []
		const server = await serve(listeners, spec, columnRoutes(seen))
		const result = await runTable(server.url)
		expect(seen[0]).toBe("add")
		expect(seen).toContain("t1:c1")
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	it("binds from the instance as it is now, after another action changed it", async () => {
		const spec = nestedSpec()
		addReorder(pathsWithoutExtract(spec))
		const world = new ColumnWorld()
		const server = await serve(listeners, spec, reorderRoutes(world))
		const result = await runTable(server.url)
		expect(world.orders.length).toBeGreaterThan(0)
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	it("removes what an x-before prelude created through an invite", async () => {
		const world = new MemberWorld()
		const server = await serve(listeners, preludeInviteSpec(), memberRoutes(world))
		await runAs(server.url, { roots: { org_id: "o1" } })
		expect(world.invited).toBeGreaterThan(0)
		expect([...world.members.keys()]).toEqual(["m_owner"])
	})

	it("seeds a list-only entity and reports a coverage gap when a path stays empty", async () => {
		const spec = nestedSpec()
		const paths = spec.paths
		if (paths === undefined) throw new Error("missing paths")
		addOrganizations(paths)
		addMemberActions(paths)
		const seen: string[] = []
		const server = await serve(listeners, spec, organizationRoutes(seen, []))
		const result = await runAs(server.url, { cohortSize: 1, only: ["member"], roots: {} })
		expect(seen).toEqual(["invite", "role"])
		const gaps = result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")
		expect(gaps.map((finding) => finding.summary).sort()).toEqual([
			"member.orphan could not be invoked",
			'member.touch could not run x-before "member.needsGhost"',
		])
	})
})
