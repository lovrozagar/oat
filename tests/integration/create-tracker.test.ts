import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define/types.ts"
import { renderJson } from "../../src/report/render/json.ts"
import { renderMarkdown } from "../../src/report/render/markdown.ts"
import { run } from "../../src/runtime/run/index.ts"
import { renderTeardown } from "../../src/runtime/teardown/render.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Every create oat sends as a configured principal is that principal's to remove. A probe that
 * writes under another tenant's root, a create declared as PUT, a scenario's create: each one the
 * backend accepts leaves a record, and teardown removes it with the credential that made it. A
 * create sent with a credential no principal holds belongs to whoever sent it, not to the ledger.
 */

interface Switches {
	/* A parent only has to exist: a row is accepted under another tenant's table. */
	foreignParent?: boolean
	/* Every DELETE beta sends is refused. */
	refuseBetaDelete?: boolean
}

const TOKENS: Record<string, { project: string; who: string }> = {
	"Bearer a": { project: "a", who: "alpha" },
	"Bearer b": { project: "b", who: "beta" },
	/* A scenario's own account in alpha's tenant: no principal holds this credential. */
	"Bearer s": { project: "a", who: "stranger" },
}

const PRINCIPALS = [
	{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { project_id: "a" } },
	{ headers: { authorization: "Bearer b" }, id: "beta", roots: { project_id: "b" } },
]

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ITEM = {
	properties: { id: { readOnly: true, type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}
const WRITE = { properties: { name: { type: "string" } }, required: ["name"], type: "object" }
const LIST = json({ properties: { items: { items: ITEM, type: "array" } }, type: "object" })
const REFUSED = { default: { description: "refused" } }
const PROJECT = { in: "path", name: "project_id", required: true, schema: { type: "string" }, "x-root": true }
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

function spec(): OpenApiDocument {
	const op = (entity: string, action: string, extra: Record<string, unknown> = {}) => ({
		operationId: `${entity}.${action}`,
		responses: REFUSED,
		"x-entity": { action, identity: "id", name: entity },
		"x-tenant": "project_id",
		...extra,
	})
	const collection = (entity: string, parents: unknown[]) => ({
		get: op(entity, "list", {
			parameters: parents,
			responses: { "200": { ...LIST, description: "ok" }, ...REFUSED },
		}),
		post: op(entity, "create", {
			parameters: parents,
			requestBody: { ...json(WRITE), required: true },
			responses: { "201": { ...json(ITEM), description: "created" }, ...REFUSED },
		}),
	})
	const item = (entity: string, parents: unknown[]) => ({
		delete: op(entity, "delete", {
			parameters: parents,
			responses: { "204": { description: "gone" }, ...REFUSED },
		}),
		get: op(entity, "read", {
			parameters: parents,
			responses: { "200": { ...json(ITEM), description: "ok" }, ...REFUSED },
		}),
	})
	const tables = [PROJECT]
	const table = [PROJECT, param("table_id")]
	const row = [...table, param("row_id")]
	const thing = [PROJECT, param("thing_id")]
	return {
		info: { title: "create-tracker", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/tables": collection("table", tables),
			"/v1/projects/{project_id}/tables/{table_id}": item("table", table),
			"/v1/projects/{project_id}/tables/{table_id}/rows": collection("row", table),
			"/v1/projects/{project_id}/tables/{table_id}/rows/{row_id}": item("row", row),
			"/v1/projects/{project_id}/things": {
				get: op("thing", "list", {
					parameters: tables,
					responses: { "200": { ...LIST, description: "ok" }, ...REFUSED },
				}),
			},
			"/v1/projects/{project_id}/things/{thing_id}": {
				...item("thing", thing),
				/* The client names the record: the create is a PUT to its own path. */
				put: op("thing", "create", {
					parameters: thing,
					requestBody: { ...json(WRITE), required: true },
					responses: { "201": { ...json(ITEM), description: "created" }, ...REFUSED },
				}),
			},
		},
	} as unknown as OpenApiDocument
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
	res.end(body === undefined ? "" : JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
				resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null)
			} catch {
				resolve(null)
			}
		})
	})
}

interface Stored {
	id: string
	name: string
	project: string
	/* Who sent the create. */
	by: string
	table?: string
}

const shown = (record: Stored) => ({ id: record.id, name: record.name })

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((close) => close()))
})

/* One request from a known caller in its own project. */
interface Call {
	caller: { project: string; who: string }
	method: string
	project: string
	req: IncomingMessage
	res: ServerResponse
}

/* Tables with rows under them, and things named by their own path, each scoped to a project. */
class TenantBackend {
	readonly tables = new Map<string, Stored>()
	readonly rows = new Map<string, Stored>()
	readonly things = new Map<string, Stored>()
	#seq = 0
	readonly #switches: Switches

	constructor(switches: Switches) {
		this.#switches = switches
	}

	left() {
		return [
			...[...this.tables.values()].map((record) => ({ entity: "table", ...record })),
			...[...this.rows.values()].map((record) => ({ entity: "row", ...record })),
			...[...this.things.values()].map((record) => ({ entity: "thing", ...record })),
		]
	}

	async route(req: IncomingMessage, res: ServerResponse) {
		const at = new URL(req.url ?? "/", "http://x")
		if (at.pathname === "/v1/openapi/spec") return send(res, 200, spec())
		const caller = TOKENS[req.headers.authorization ?? ""]
		if (caller === undefined) return send(res, 401, { error: "unauthenticated" })
		const parts = at.pathname.split("/").filter(Boolean).map(decodeURIComponent)
		/* v1 projects {p} <collection> [{id} [rows [{id}]]] */
		if (parts[0] !== "v1" || parts[1] !== "projects" || parts[2] !== caller.project) {
			return send(res, 404, { error: "missing" })
		}
		const call: Call = { caller, method: req.method ?? "GET", project: parts[2], req, res }
		if (call.method === "DELETE" && this.#switches.refuseBetaDelete === true && caller.who === "beta") {
			return send(res, 403, { error: "forbidden" })
		}
		if (parts[3] === "things") return this.#thing(call, parts)
		if (parts[3] !== "tables") return send(res, 404, { error: "missing" })
		if (parts.length === 4) return this.#tableList(call)
		return this.#underTable(call, parts)
	}

	/* `placed` is the id the new record takes, and the table it lands under when it has one. */
	async #create(call: Call, store: Map<string, Stored>, { id, ...under }: Pick<Stored, "id" | "table">) {
		const body = await readJson(call.req)
		if (body === null || typeof body.name !== "string") return send(call.res, 400, { error: "name is required" })
		const record: Stored = { by: call.caller.who, id, name: body.name, project: call.project, ...under }
		store.set(id, record)
		return send(call.res, 201, shown(record))
	}

	#one(call: Call, store: Map<string, Stored>, record: Stored | undefined) {
		if (record === undefined) return send(call.res, 404, { error: "missing" })
		if (call.method === "GET") return send(call.res, 200, shown(record))
		if (call.method === "DELETE") {
			store.delete(record.id)
			return send(call.res, 204)
		}
		return send(call.res, 405)
	}

	#listed(call: Call, store: Map<string, Stored>) {
		return send(call.res, 200, { items: [...store.values()].filter((t) => t.project === call.project).map(shown) })
	}

	#thing(call: Call, parts: string[]) {
		if (parts.length === 4 && call.method === "GET") return this.#listed(call, this.things)
		const id = parts[4] ?? ""
		const found = this.things.get(id)
		if (call.method === "PUT") {
			if (found !== undefined) return send(call.res, 409, { error: "taken" })
			return this.#create(call, this.things, { id })
		}
		return this.#one(call, this.things, found?.project === call.project ? found : undefined)
	}

	#tableList(call: Call) {
		if (call.method === "GET") return this.#listed(call, this.tables)
		if (call.method === "POST") return this.#create(call, this.tables, { id: `t${++this.#seq}` })
		return send(call.res, 405)
	}

	#underTable(call: Call, parts: string[]) {
		const candidate = this.tables.get(parts[4] ?? "")
		/* A correct backend serves a table only under its own project. */
		const table =
			candidate !== undefined && (candidate.project === call.project || this.#switches.foreignParent === true)
				? candidate
				: undefined
		if (parts.length === 5)
			return this.#one(call, this.tables, candidate?.project === call.project ? candidate : undefined)
		if (table === undefined || parts[5] !== "rows") return send(call.res, 404, { error: "missing" })
		return this.#rows(call, parts, table)
	}

	#rows(call: Call, parts: string[], table: Stored) {
		const inTable = (record: Stored) => record.table === table.id && record.project === call.project
		if (parts.length === 6) {
			if (call.method === "GET")
				return send(call.res, 200, { items: [...this.rows.values()].filter(inTable).map(shown) })
			if (call.method === "POST") return this.#create(call, this.rows, { id: `r${++this.#seq}`, table: table.id })
			return send(call.res, 405)
		}
		const row = this.rows.get(parts[6] ?? "")
		return this.#one(call, this.rows, row !== undefined && inTable(row) ? row : undefined)
	}
}

async function serve(switches: Switches = {}) {
	const backend = new TenantBackend(switches)
	const server = createServer((req, res) => {
		void backend.route(req, res)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	servers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return {
		left: () => backend.left(),
		rows: backend.rows,
		tables: backend.tables,
		things: backend.things,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	}
}

async function runAgainst(switches: Switches, scenarios: Scenario[] = []) {
	const backend = await serve(switches)
	const result = await run({
		baseUrl: backend.url,
		principals: PRINCIPALS,
		...(scenarios.length === 0 ? {} : { scenarios }),
		seed: 1,
		spec: `${backend.url}/v1/openapi/spec`,
	})
	return { ...backend, result }
}

const pathOf = (url: string) => new URL(url).pathname

type RunResult = Awaited<ReturnType<typeof runAgainst>>["result"]

/* The creates seeding sent, and those of them that are a ledgered record or a reported create. */
function seedCreates(result: RunResult) {
	const records = result.teardown?.records ?? []
	const unidentified = new Set((result.teardown?.unidentified ?? []).map((create) => create.seq))
	const seeded = result.client.transcript.filter(
		(exchange) =>
			exchange.purpose === "seed" &&
			exchange.method === "POST" &&
			exchange.status === 201 &&
			exchange.operationId?.endsWith(".create") === true,
	)
	const accounted = seeded.filter(
		(exchange) =>
			unidentified.has(exchange.seq) ||
			records.some(
				(record) =>
					record.id === (exchange.responseBody as { id: string }).id && record.principal === exchange.principal,
			),
	)
	return { accounted, seeded }
}

/* The run as a report renders it. */
function reportOf(result: RunResult) {
	return {
		baseUrl: "http://x",
		checksRun: result.checksRun,
		client: result.client,
		durationMs: 0,
		entitiesTested: result.entitiesTested,
		findings: result.findings,
		model: result.model,
		startedAt: new Date(0),
		teardown: result.teardown,
	}
}

describe("a create by a configured principal", () => {
	it("under another tenant's parent is ledgered as the principal that sent it, and removed as it", async () => {
		const { left, result, rows, tables } = await runAgainst({ foreignParent: true })
		/* The probe made a row in beta's tenant under alpha's table: the leak this guards. */
		const transcript = result.client.transcript
		const probed = transcript.find(
			(exchange) =>
				exchange.method === "POST" &&
				exchange.check === "tenant.parent-not-reachable-from-another-root" &&
				exchange.status === 201,
		)
		const probeRow = (probed?.responseBody as { id: string } | undefined)?.id
		expect(probeRow).toBeDefined()
		expect(left()).toEqual([])
		expect(rows.size + tables.size).toBe(0)
		const removal = transcript.find(
			(exchange) =>
				exchange.method === "DELETE" &&
				exchange.purpose === "teardown" &&
				pathOf(exchange.url).endsWith(`/${probeRow}`),
		)
		expect(removal?.principal).toBe("beta")
		expect(removal?.status).toBe(204)
		expect(result.teardown?.records).toContainEqual(
			expect.objectContaining({ entity: "row", id: probeRow, principal: "beta", removed: true }),
		)
		/* The record is proven gone by its creator's own view of the list it lived in. */
		const relisted = transcript.filter(
			(exchange) =>
				exchange.method === "GET" &&
				exchange.purpose === "teardown" &&
				pathOf(exchange.url) === pathOf(removal?.url ?? "").replace(/\/[^/]+$/, ""),
		)
		expect(relisted.length).toBeGreaterThan(0)
		expect(relisted.every((exchange) => exchange.principal === "beta")).toBe(true)

		/* Seeding ledgers its own creates: each one it sent is a ledgered record or a reported create. */
		const { accounted, seeded } = seedCreates(result)
		expect(seeded.length).toBeGreaterThan(0)
		expect(accounted.length).toBe(seeded.length)
	}, 120_000)
})

describe("a create by a configured principal", () => {
	it("declared as a PUT to the record's own path is torn down", async () => {
		const scenario: Scenario = {
			covers: ["thing.create"],
			id: "name-a-thing",
			steps: [{ bind: { thing_id: "thing-1" }, body: { name: "one" }, operationId: "thing.create" }],
		}
		const { left, result, things } = await runAgainst({}, [scenario])
		const put = result.client.transcript.filter((exchange) => exchange.method === "PUT" && exchange.status === 201)
		expect(put.length).toBeGreaterThan(0)
		expect(things.size).toBe(0)
		expect(left()).toEqual([])
		expect(result.teardown?.records).toContainEqual(
			expect.objectContaining({ entity: "thing", id: "thing-1", principal: "alpha", removed: true }),
		)
	}, 120_000)

	it("that its principal may not delete is named as left behind, with that principal", async () => {
		const { left, result } = await runAgainst({ foreignParent: true, refuseBetaDelete: true })
		const remaining = left()
		expect(remaining.length).toBeGreaterThan(0)
		expect(remaining.every((record) => record.project === "b")).toBe(true)
		const failed = result.teardown?.failed ?? []
		expect(failed.map(({ entity, id }) => `${entity} ${id}`).toSorted()).toEqual(
			remaining.map(({ entity, id }) => `${entity} ${id}`).toSorted(),
		)
		expect(failed.every((failure) => failure.principal === "beta")).toBe(true)

		/* Whoever cleans up by hand needs to know whose tenant each record is in. */
		const first = failed[0]
		const report = reportOf(result)
		expect(renderMarkdown(report)).toContain(`- ${first?.entity} \`${first?.id}\` · as beta · `)
		expect(JSON.parse(renderJson(report)).teardown.failed[0].principal).toBe("beta")
		expect(renderTeardown(result.teardown!, result.created).join("\n")).toContain(
			`${first?.entity} ${first?.id} (as beta)`,
		)
	}, 120_000)
})

describe("a create by a principal configured with no credential of its own", () => {
	it("is that principal's, even when every request carries a global key", async () => {
		const backend = await serve()
		const result = await run({
			baseUrl: backend.url,
			globalHeaders: { authorization: "Bearer a" },
			principals: [{ id: "alpha", roots: { project_id: "a" } }],
			seed: 1,
			spec: `${backend.url}/v1/openapi/spec`,
		})
		expect(result.teardown?.records.length ?? 0).toBeGreaterThan(0)
		expect(backend.left()).toEqual([])
	}, 120_000)
})

describe("a create sent with a credential no principal holds", () => {
	it("is the scenario's own: neither ledgered nor reported unidentified", async () => {
		const scenario: Scenario = {
			covers: ["thing.create"],
			id: "stranger-makes-a-thing",
			steps: [
				{
					bind: { thing_id: "stranger-1" },
					body: { name: "theirs" },
					headers: { authorization: "Bearer s" },
					operationId: "thing.create",
				},
			],
		}
		const { result, things } = await runAgainst({}, [scenario])
		expect(things.get("stranger-1")?.by).toBe("stranger")
		expect((result.teardown?.records ?? []).some((record) => record.id === "stranger-1")).toBe(false)
		expect(result.teardown?.unidentified ?? []).toEqual([])
	}, 120_000)
})
