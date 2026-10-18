import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { runCheck as planAndRun } from "../../src/runtime/checks/core/run.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { Client } from "../../src/client/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { SchemaValidator } from "../../src/runtime/validate.ts"
import type { Record_ } from "../../src/runtime/world.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * The case check searches a token, then the token with its first letter's case flipped. A record
 * another check creates between those reads shows up in the second search only. That is the
 * collection moving, not case mattering. A search that really is case-sensitive is still reported.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const COHORT: Record_[] = [
	{ category: "general", created_at: 100, id: "t-a", name: "Oat Template" },
	{ category: "billing", created_at: 200, id: "t-b", name: "Oat Report" },
	{ category: "general", created_at: 300, id: "t-c", name: "Other" },
]

const ITEM = {
	properties: {
		category: { type: "string" },
		created_at: { type: "integer" },
		id: { type: "string" },
		name: { type: "string" },
	},
	required: ["id", "category", "created_at", "name"],
	type: "object",
}

function spec(): OpenApiDocument {
	return {
		info: { title: "moving-search", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/templates": {
				get: {
					operationId: "template.list",
					parameters: [
						{ in: "query", name: "filter", schema: { type: "string" } },
						{ in: "query", name: "q", schema: { type: "string" } },
						{ in: "query", name: "limit", schema: { default: 20, maximum: 100, minimum: 1, type: "integer" } },
						{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { templates: { items: ITEM, type: "array" } },
										required: ["templates"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "template" },
					"x-query": {
						filterable: [
							{ field: "category", ops: ["eq"], type: "string" },
							{ field: "created_at", ops: ["eq", "gt", "gte", "lt"], type: "integer" },
						],
						grammar: "postgrest",
						maxLimit: 100,
						searchCase: "insensitive",
						searchable: ["name"],
					},
				},
			},
		},
	} as OpenApiDocument
}

function select(rows: Record_[], search: string | null, caseSensitive: boolean): Record_[] {
	if (search === null) return rows
	return rows.filter((row) => {
		const name = String(row["name"])
		return caseSensitive ? name.includes(search) : name.toLowerCase().includes(search.toLowerCase())
	})
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function run(opts: { grows: boolean; caseSensitive: boolean }): Promise<FindingCollector> {
	const id = "search.case-insensitive"
	const check = CHECKS.find((item) => item.id === id)
	if (check === undefined) throw new Error(`no check ${id}`)
	const model = buildModel(dereference(spec()).doc)
	const listOp = model.byOperationId.get("template.list")
	if (listOp === undefined) throw new Error("missing template.list")
	const store = [...COHORT]
	const url = await listen((req, res) => {
		const at = new URL(req.url ?? "/", "http://127.0.0.1")
		const search = at.searchParams.get("q")
		/* Another check creates a matching template just before the flipped search is read. */
		const flipped = search !== null && search[0] === search[0]?.toLowerCase()
		if (opts.grows && flipped && !store.some((row) => row.id === "t-new")) {
			store.push({ category: "general", created_at: 999, id: "t-new", name: "Oat New" })
		}
		const rows = select(store, search, opts.caseSensitive)
		const limit = Number(at.searchParams.get("limit") ?? 20)
		const page = Number(at.searchParams.get("page") ?? 1)
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ templates: rows.slice((page - 1) * limit, page * limit) }))
	})
	const findings = new FindingCollector()
	const ctx = checkContext({
		actors: [],
		altAuth: undefined,
		altScope: undefined,
		asyncOps: [],
		auth: () => ({}),
		client: new Client({ baseUrl: url, redactor: new Redactor() }),
		collectionKey: listOp.collection?.key ?? "templates",
		createOp: undefined,
		deleteOp: undefined,
		effectOps: [],
		entityName: "template",
		findings,
		hooks: {},
		identity: "id",
		invite: null,
		listOp,
		model,
		outOfBand: { attempts: 6, initialMs: 200, maxMs: 3000 },
		query: listOp.query,
		readOp: undefined,
		records: COHORT,
		scope: {},
		seed: 1,
		softDelete: null,
		updateOp: undefined,
		uploads: { seed: 1 },
		validator: new SchemaValidator(),
		waitOps: [],
	})
	expect(check.plan(ctx).ok).toBe(true)
	await planAndRun(check, ctx)
	return findings
}

function bugs(findings: FindingCollector) {
	return findings.findings.filter(
		(finding) => finding.check === "search.case-insensitive" && finding.verdict === "BACKEND_BUG",
	)
}

describe("case-flipped search on a collection that grows while it is read", () => {
	it("does not call a record created mid-check a case difference", async () => {
		expect(bugs(await run({ caseSensitive: false, grows: true }))).toEqual([])
	})

	it("still reports a search that is case-sensitive", async () => {
		expect(bugs(await run({ caseSensitive: true, grows: false }))).toHaveLength(1)
	})
})
