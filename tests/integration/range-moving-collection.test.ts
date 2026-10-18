import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { runCheck as planAndRun } from "../../src/runtime/checks/core/run.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { Client } from "../../src/client/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { SchemaValidator } from "../../src/runtime/validate.ts"
import type { Record_ } from "../../src/runtime/world/records.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * The range check reads gte, then gt, then eq. A record another check creates between those reads
 * shows up in gt but not in the earlier gte. That is the collection moving, not gte missing a
 * record. A gte that really drops the equal record must still be reported.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const COHORT: Record_[] = [
	{ category: "general", created_at: 100, id: "t-a" },
	{ category: "billing", created_at: 200, id: "t-b" },
	{ category: "general", created_at: 300, id: "t-c" },
]

const ITEM = {
	properties: { category: { type: "string" }, created_at: { type: "integer" }, id: { type: "string" } },
	required: ["id", "category", "created_at"],
	type: "object",
}

function spec(): OpenApiDocument {
	return {
		info: { title: "moving-range", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/templates": {
				get: {
					operationId: "template.list",
					parameters: [
						{ in: "query", name: "filter", schema: { type: "string" } },
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
					},
				},
			},
		},
	} as OpenApiDocument
}

function matches(row: Record_, term: string, gteDropsEqual: boolean): boolean {
	const [field = "", op = "", raw = ""] = term.split(".")
	const value = row[field]
	if (op === "eq") return String(value) === raw
	if (typeof value !== "number") return false
	if (op === "gt") return value > Number(raw)
	if (op === "gte") return gteDropsEqual ? value > Number(raw) : value >= Number(raw)
	if (op === "lt") return value < Number(raw)
	return false
}

function select(rows: Record_[], filter: string | null, gteDropsEqual: boolean): Record_[] {
	if (filter === null) return rows
	return rows.filter((row) => matches(row, filter, gteDropsEqual))
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function run(opts: { grows: boolean; gteDropsEqual: boolean }): Promise<FindingCollector> {
	const id = "filter.gte-is-gt-or-eq"
	const check = CHECKS.find((item) => item.id === id)
	if (check === undefined) throw new Error(`no check ${id}`)
	const model = buildModel(dereference(spec()).doc)
	const listOp = model.byOperationId.get("template.list")
	if (listOp === undefined) throw new Error("missing template.list")
	const store = [...COHORT]
	const url = await listen((req, res) => {
		const at = new URL(req.url ?? "/", "http://127.0.0.1")
		const filter = at.searchParams.get("filter")
		/* Another check creates a later template just before the gt term is read. */
		if (opts.grows && filter?.includes(".gt.") === true && !store.some((row) => row.id === "t-new")) {
			store.push({ category: "general", created_at: 999, id: "t-new" })
		}
		const rows = select(store, filter, opts.gteDropsEqual)
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
		(finding) => finding.check === "filter.gte-is-gt-or-eq" && finding.verdict === "BACKEND_BUG",
	)
}

describe("gte against gt ∪ eq on a collection that grows while it is read", () => {
	it("does not call a record created mid-check a gte miss", async () => {
		expect(bugs(await run({ grows: true, gteDropsEqual: false }))).toEqual([])
	})

	it("still reports a gte that drops the equal record", async () => {
		expect(bugs(await run({ grows: false, gteDropsEqual: true }))).toHaveLength(1)
	})
})
