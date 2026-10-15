import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { CHECKS, runCheck as planAndRun } from "../src/runtime/checks.ts"
import { Client } from "../src/runtime/client.ts"
import { FindingCollector } from "../src/runtime/finding.ts"
import { SchemaValidator } from "../src/runtime/validate.ts"
import type { Record_ } from "../src/runtime/world.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { checkContext } from "./support/check-context.ts"

/*
 * An append-only log (an audit trail) gains rows while it is read: the run that reads it is also
 * writing to it. Two reads a moment apart hold different rows, and that is not a sorting bug. A
 * sort that really is broken on a log that holds still must still be reported.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

/* Rows tie on created_at (second resolution), as an audit trail written in bursts does. */
const COHORT: Record_[] = [
	{ created_at: 100, id: "log-a" },
	{ created_at: 100, id: "log-b" },
	{ created_at: 200, id: "log-c" },
]

function spec(): OpenApiDocument {
	return {
		info: { title: "moving-log", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/logs": {
				get: {
					operationId: "log.list",
					parameters: [
						{ in: "query", name: "order", schema: { type: "string" } },
						{ in: "query", name: "limit", schema: { default: 20, maximum: 100, minimum: 1, type: "integer" } },
						{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: {
											logs: {
												items: {
													properties: { created_at: { type: "integer" }, id: { type: "string" } },
													required: ["id", "created_at"],
													type: "object",
												},
												type: "array",
											},
										},
										required: ["logs"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "log" },
					"x-query": {
						defaultOrder: "created_at.desc",
						grammar: "postgrest",
						maxLimit: 100,
						sortable: ["created_at"],
						stableTiebreak: "id",
					},
				},
			},
		},
	} as OpenApiDocument
}

function send(res: ServerResponse, body: unknown): void {
	const text = JSON.stringify(body)
	res.writeHead(200, { "content-type": "application/json" })
	res.end(text)
}

/** Sorted by created_at, ties by id ascending: a correct, deterministic order. */
function ordered(rows: Record_[], order: string, shuffleTies: boolean): Record_[] {
	const [field = "created_at", direction = "desc"] = order.split(".")
	const sign = direction === "asc" ? 1 : -1
	const tie = () => (shuffleTies ? Math.random() - 0.5 : 0)
	return [...rows].sort((a, b) => {
		const primary = (Number(a[field]) - Number(b[field])) * sign
		if (primary !== 0) return primary
		return shuffleTies ? tie() : String(a.id).localeCompare(String(b.id))
	})
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function run(checkId: string, opts: { grows: boolean; shuffleTies?: boolean }): Promise<FindingCollector> {
	const check = CHECKS.find((item) => item.id === checkId)
	if (check === undefined) throw new Error(`no check ${checkId}`)
	const model = buildModel(dereference(spec()).doc)
	const listOp = model.byOperationId.get("log.list")
	if (listOp === undefined) throw new Error("missing log.list")
	const store = [...COHORT]
	let reads = 0
	const url = await listen((req, res) => {
		const at = new URL(req.url ?? "/", "http://127.0.0.1")
		reads += 1
		/* Every other read lands after a background write. */
		if (opts.grows && reads % 2 === 0) store.push({ created_at: 300 + reads, id: `log-new-${reads}` })
		const rows = ordered(store, at.searchParams.get("order") ?? "created_at.desc", opts.shuffleTies === true)
		const limit = Number(at.searchParams.get("limit") ?? 20)
		const page = Number(at.searchParams.get("page") ?? 1)
		send(res, { logs: rows.slice((page - 1) * limit, page * limit) })
	})
	const findings = new FindingCollector()
	const ctx = checkContext({
		actors: [],
		altAuth: undefined,
		altScope: undefined,
		asyncOps: [],
		auth: () => ({}),
		client: new Client(url),
		collectionKey: listOp.collection?.key ?? "logs",
		createOp: undefined,
		deleteOp: undefined,
		effectOps: [],
		entityName: "log",
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

function bugs(findings: FindingCollector, checkId: string) {
	return findings.findings.filter((finding) => finding.check === checkId && finding.verdict === "BACKEND_BUG")
}

describe("sort checks on a collection that grows while it is read", () => {
	for (const id of ["sort.reverse-symmetry", "sort.default-order-applied", "sort.stable-tiebreak"]) {
		it(`${id} does not call growth a sorting bug`, async () => {
			expect(bugs(await run(id, { grows: true }), id)).toEqual([])
		})
	}

	it("still reports ties that come back in a different order each time", async () => {
		let reported = false
		/* Two tied rows shuffle into the same order on both reads half the time, and a pair always
		 * reads as one direction, so a try shows the bug with odds of one half: twenty leave a miss
		 * at one in a million. */
		for (let attempt = 0; attempt < 20 && !reported; attempt++) {
			reported =
				bugs(await run("sort.stable-tiebreak", { grows: false, shuffleTies: true }), "sort.stable-tiebreak").length > 0
		}
		expect(reported).toBe(true)
	})
})
