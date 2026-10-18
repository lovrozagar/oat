import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A parent named by a slug the server derives from its name: two tenants can each hold their own
 * `quarterly-report-0`. The owner's parent placed under the other tenant's root then reaches the
 * other tenant's own parent — a correct answer, not a crossed boundary. The check says it cannot
 * tell, and still reports a backend that resolves the slug in another tenant.
 */

const CHECK = "tenant.parent-not-reachable-from-another-root"

interface Options {
	/* A slug the path's project does not hold is looked up in every project. */
	crossResolve?: boolean
	/* Tables each project holds before oat arrives, by name. */
	existing?: Record<string, string[]>
}

const TOKENS: Record<string, string> = { "Bearer a": "a", "Bearer b": "b" }

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const TABLE = {
	properties: { name: { type: "string" }, slug: { readOnly: true, type: "string" } },
	required: ["slug", "name"],
	type: "object",
}
const ROW = {
	properties: { id: { readOnly: true, type: "string" }, label: { type: "string" } },
	required: ["id", "label"],
	type: "object",
}
const REFUSED = { default: { description: "refused" } }
const PROJECT = { in: "path", name: "project_id", required: true, schema: { type: "string" }, "x-root": true }
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

const op = (entity: string, identity: string, action: string, extra: Record<string, unknown>) => ({
	operationId: `${entity}.${action}`,
	"x-entity": { action, identity, name: entity },
	"x-tenant": "project_id",
	...extra,
})
const write = (schema: { properties: Record<string, unknown> }, field: string) => ({
	...json({ properties: { [field]: schema.properties[field] }, required: [field], type: "object" }),
	required: true,
})

function spec(): OpenApiDocument {
	const resource = (
		entity: string,
		identity: string,
		item: unknown,
		field: string,
		parents: unknown[],
		id: string,
	) => ({
		collection: {
			get: op(entity, identity, "list", {
				parameters: parents,
				responses: {
					"200": {
						...json({ properties: { items: { items: item, type: "array" } }, type: "object" }),
						description: "ok",
					},
					...REFUSED,
				},
			}),
			post: op(entity, identity, "create", {
				parameters: parents,
				requestBody: write(item as { properties: Record<string, unknown> }, field),
				responses: { "201": { ...json(item), description: "created" }, ...REFUSED },
			}),
		},
		item: {
			delete: op(entity, identity, "delete", {
				parameters: [...parents, param(id)],
				responses: { "204": { description: "gone" }, ...REFUSED },
			}),
			get: op(entity, identity, "read", {
				parameters: [...parents, param(id)],
				responses: { "200": { ...json(item), description: "ok" }, ...REFUSED },
			}),
		},
	})
	const tables = resource("table", "slug", TABLE, "name", [PROJECT], "table_id")
	const rows = resource("row", "id", ROW, "label", [PROJECT, param("table_id")], "row_id")
	return {
		info: { title: "foreign-parent-collision", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects/{project_id}/tables": tables.collection,
			"/v1/projects/{project_id}/tables/{table_id}": tables.item,
			"/v1/projects/{project_id}/tables/{table_id}/rows": rows.collection,
			"/v1/projects/{project_id}/tables/{table_id}/rows/{row_id}": rows.item,
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

/* `Quarterly Report 0` → `quarterly-report-0`. */
const slugOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")

interface Table {
	key: string
	project: string
	slug: string
	name: string
}
interface Row {
	id: string
	project: string
	table: string
	label: string
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((close) => close()))
})

async function serve(options: Options = {}) {
	/* Keyed internally; reached by (project, slug). */
	const tables = new Map<string, Table>()
	const rows = new Map<string, Row>()
	let seq = 0
	const addTable = (project: string, name: string): Table => {
		const table = { key: `k${++seq}`, name, project, slug: slugOf(name) }
		tables.set(table.key, table)
		return table
	}
	for (const [project, names] of Object.entries(options.existing ?? {})) {
		for (const name of names) addTable(project, name)
	}
	const tableAt = (project: string, slug: string): Table | undefined => {
		const own = [...tables.values()].find((table) => table.project === project && table.slug === slug)
		if (own !== undefined || options.crossResolve !== true) return own
		return [...tables.values()].find((table) => table.slug === slug)
	}
	const shownTable = (table: Table) => ({ name: table.name, slug: table.slug })
	const shownRow = (row: Row) => ({ id: row.id, label: row.label })
	const server = createServer((req, res) => {
		void (async () => {
			const at = new URL(req.url ?? "/", "http://x")
			const method = req.method ?? "GET"
			if (at.pathname === "/v1/openapi/spec") return send(res, 200, spec())
			const caller = TOKENS[req.headers.authorization ?? ""]
			if (caller === undefined) return send(res, 401, { error: "unauthenticated" })
			const parts = at.pathname.split("/").filter(Boolean).map(decodeURIComponent)
			if (parts[0] !== "v1" || parts[1] !== "projects" || parts[2] !== caller || parts[3] !== "tables") {
				return send(res, 404, { error: "missing" })
			}
			const project = parts[2]
			if (parts.length === 4) {
				if (method === "GET") {
					const own = [...tables.values()].filter((table) => table.project === project)
					return send(res, 200, { items: own.map(shownTable) })
				}
				if (method !== "POST") return send(res, 405)
				const body = await readJson(req)
				if (body === null || typeof body.name !== "string") return send(res, 400, { error: "name is required" })
				const slug = slugOf(body.name)
				if (slug === "") return send(res, 400, { error: "name has no letters" })
				if ([...tables.values()].some((table) => table.project === project && table.slug === slug)) {
					return send(res, 409, { error: "slug taken" })
				}
				return send(res, 201, shownTable(addTable(project, body.name)))
			}
			const table = tableAt(project, parts[4] ?? "")
			if (table === undefined) return send(res, 404, { error: "missing" })
			if (parts.length === 5) {
				if (table.project !== project) return send(res, 404, { error: "missing" })
				if (method === "GET") return send(res, 200, shownTable(table))
				if (method === "DELETE") {
					tables.delete(table.key)
					for (const row of rows.values()) if (row.table === table.key) rows.delete(row.id)
					return send(res, 204)
				}
				return send(res, 405)
			}
			if (parts[5] !== "rows") return send(res, 404, { error: "missing" })
			const inTable = (row: Row) => row.table === table.key && row.project === project
			if (parts.length === 6) {
				if (method === "GET") return send(res, 200, { items: [...rows.values()].filter(inTable).map(shownRow) })
				if (method !== "POST") return send(res, 405)
				const body = await readJson(req)
				if (body === null || typeof body.label !== "string") return send(res, 400, { error: "label is required" })
				const row = { id: `r${++seq}`, label: body.label, project, table: table.key }
				rows.set(row.id, row)
				return send(res, 201, shownRow(row))
			}
			const row = rows.get(parts[6] ?? "")
			if (row === undefined || !inTable(row)) return send(res, 404, { error: "missing" })
			if (method === "GET") return send(res, 200, shownRow(row))
			if (method === "DELETE") {
				rows.delete(row.id)
				return send(res, 204)
			}
			return send(res, 405)
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	servers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function runAgainst(options: Options, roots: { a: Record<string, string>; b: Record<string, string> }) {
	const backend = await serve(options)
	return run({
		baseUrl: backend.url,
		nonce: "n1",
		principals: [
			{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { project_id: "a", ...roots.a } },
			{ headers: { authorization: "Bearer b" }, id: "beta", roots: { project_id: "b", ...roots.b } },
		],
		seed: 1,
		spec: `${backend.url}/v1/openapi/spec`,
	})
}

const breaches = (result: Awaited<ReturnType<typeof run>>) =>
	result.findings.filter(
		(finding) => finding.check === CHECK && (finding.verdict === "SECURITY" || finding.verdict === "AMBIGUITY"),
	)

describe("the owner's parent under another tenant's root", () => {
	it("reaching the other tenant's own parent of the same slug is unresolved, not a breach", async () => {
		/* What alpha names its scaffolding table under the fixed nonce: the other tenant holds its own. */
		const result = await runAgainst({ existing: { b: ["Quarterly Report 0 n1"] } }, { a: {}, b: {} })
		expect(result.checksRun).toContain(CHECK)
		expect(breaches(result)).toEqual([])
		const unresolved = result.inconclusive.filter((entry) => entry.check === CHECK)
		expect(unresolved).toHaveLength(1)
		expect(unresolved[0]?.reason).toContain("quarterly-report-0-n1")
	}, 120_000)

	it("is not probed when both principals are configured with the same parent", async () => {
		const shared = { table_id: "shared" }
		const result = await runAgainst({ existing: { a: ["Shared"], b: ["Shared"] } }, { a: shared, b: shared })
		expect(result.checksSkipped).toContainEqual(
			expect.objectContaining({
				check: CHECK,
				needs: "the other tenant's table_id has the same identity as the owner's",
			}),
		)
		expect(breaches(result)).toEqual([])
	}, 120_000)

	it("is still a breach when the backend resolves the slug in another tenant", async () => {
		const result = await runAgainst({ crossResolve: true }, { a: {}, b: {} })
		expect(breaches(result).map((finding) => finding.verdict)).toContain("SECURITY")
	}, 120_000)
})

describe("a parent oat creates as scaffolding", () => {
	it("never takes a slug the entity's own cohort takes", async () => {
		const backend = await serve()
		const result = await run({
			baseUrl: backend.url,
			nonce: "n1",
			principals: [{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { project_id: "a" } }],
			seed: 1,
			spec: `${backend.url}/v1/openapi/spec`,
		})
		const creates = result.client.transcript.filter(
			(exchange) => exchange.purpose === "seed" && exchange.operationId === "table.create",
		)
		expect(creates.length).toBeGreaterThan(1)
		expect(creates.filter((exchange) => exchange.status === 409)).toEqual([])
		expect(result.findings.filter((finding) => finding.check === "world.seed")).toEqual([])
	}, 120_000)
})

describe("a second principal's seeds", () => {
	it("differ from the first principal's in every string field", async () => {
		const result = await runAgainst({}, { a: {}, b: {} })
		const seeded = (principal: string) =>
			result.client.transcript.find(
				(exchange) =>
					exchange.purpose === "seed" && exchange.operationId === "table.create" && exchange.principal === principal,
			)?.requestBody as Record<string, unknown> | undefined
		const alpha = seeded("alpha")
		const beta = seeded("beta")
		expect(alpha).toBeDefined()
		expect(beta).toBeDefined()
		const strings = Object.keys(alpha ?? {}).filter((key) => typeof alpha?.[key] === "string")
		expect(strings.length).toBeGreaterThan(0)
		for (const key of strings) expect(beta?.[key]).not.toBe(alpha?.[key])
	}, 120_000)
})
