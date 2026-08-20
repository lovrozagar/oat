import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { CHECKS } from "../src/runtime/checks.ts"
import { Client } from "../src/runtime/client.ts"
import { FindingCollector } from "../src/runtime/finding.ts"
import type { Record_ } from "../src/runtime/world.ts"
import { SchemaValidator } from "../src/runtime/validate.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const TEXT_COMPARE = "compared as text rather than as a number"

/** Cohort values whose numeric order disagrees with text order (`13` vs `5`). */
const COHORT: Record_[] = [
	{ amount: 2, id: "n-low", note: "present", tags: ["red"] },
	{ amount: 5, id: "n-mid", note: null, tags: ["red"] },
	{ amount: 13, id: "n-high", note: "present", tags: ["blue"] },
]

/** Rows the live store holds that oat never seeded. */
const OUTSIDE: Record_[] = [
	{ amount: 9, id: "x-gt", note: null, tags: ["red"] },
	{ amount: 9, id: "x-gt-2", note: "present", tags: ["green"] },
]

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

function itemSchema(): Record<string, unknown> {
	return {
		properties: {
			amount: { type: "number" },
			id: { type: "string" },
			note: { type: ["string", "null"] },
			tags: { items: { type: "string" }, type: "array" },
		},
		required: ["id", "amount"],
		type: "object",
	}
}

function listSpec(): OpenApiDocument {
	return {
		info: { title: "numeric-filter", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/widgets": {
				get: {
					operationId: "widget.list",
					parameters: [
						{
							description: "PostgREST-style filter: field.op.value, e.g. amount.gt.5",
							in: "query",
							name: "filter",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "limit",
							schema: { default: 20, maximum: 100, minimum: 1, type: "integer" },
						},
						{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { widgets: { items: itemSchema(), type: "array" } },
										required: ["widgets"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "widget" },
					"x-query": {
						filterable: [
							{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" },
							{ field: "note", ops: ["eq", "is"], type: "string" },
							{ field: "tags", ops: ["contains"], type: "array" },
						],
						grammar: "postgrest",
						maxLimit: 100,
					},
				},
			},
		},
	} as OpenApiDocument
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
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

type CompareMode = "numeric" | "lexical"

interface HandlerOpts {
	compare: CompareMode
	dropKnownMatch?: boolean
	includeKnownNonMatch?: boolean
	store: Record_[]
}

function matchesFilter(row: Record_, filter: string, compare: CompareMode): boolean {
	const isNull = /^([^.]+)\.is\.(null|notnull)$/.exec(filter)
	if (isNull !== null) {
		const field = isNull[1] as string
		const wantNull = isNull[2] === "null"
		const isNullValue = row[field] === null || row[field] === undefined
		return wantNull ? isNullValue : !isNullValue
	}
	const contains = /^([^.]+)\.contains\.(.+)$/.exec(filter)
	if (contains !== null) {
		const field = contains[1] as string
		const element = contains[2] as string
		return Array.isArray(row[field]) && (row[field] as unknown[]).some((item) => String(item) === element)
	}
	const gt = /^([^.]+)\.gt\.(.+)$/.exec(filter)
	if (gt !== null) {
		const field = gt[1] as string
		const threshold = gt[2] as string
		const value = row[field]
		if (typeof value !== "number") return false
		return compare === "lexical" ? String(value) > threshold : value > Number(threshold)
	}
	return true
}

function filterStore(opts: HandlerOpts, filter: string | null): Record_[] {
	const known = new Set(COHORT.map((row) => String(row.id)))
	let rows =
		filter === null || filter === ""
			? [...opts.store]
			: opts.store.filter((row) => matchesFilter(row, filter, opts.compare))
	if (opts.dropKnownMatch === true) {
		const victim = rows.find((row) => known.has(String(row.id)))
		if (victim !== undefined) rows = rows.filter((row) => row.id !== victim.id)
	}
	if (opts.includeKnownNonMatch === true) {
		const included = new Set(rows.filter((row) => known.has(String(row.id))).map((row) => String(row.id)))
		const extra = COHORT.find((row) => !included.has(String(row.id)))
		if (extra !== undefined) rows = [...rows, extra]
	}
	return rows
}

async function runCheck(
	checkId: string,
	opts: HandlerOpts,
): Promise<{ findings: FindingCollector; requests: string[] }> {
	const check = CHECKS.find((item) => item.id === checkId)
	expect(check).toBeDefined()
	const model = buildModel(dereference(listSpec()).doc)
	const listOp = model.byOperationId.get("widget.list")
	expect(listOp).toBeDefined()
	if (listOp === undefined) throw new Error("missing widget.list")

	const requests: string[] = []
	const server = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		requests.push(`${req.method ?? "GET"} ${url.pathname}${url.search}`)
		if (req.method === "GET" && url.pathname === "/v1/widgets") {
			send(res, 200, { widgets: filterStore(opts, url.searchParams.get("filter")) })
			return
		}
		send(res, 404)
	})
	closers.push(server.close)

	const findings = new FindingCollector()
	const ctx = {
		actors: [],
		altAuth: undefined,
		altScope: undefined,
		asyncOps: [],
		auth: () => ({}),
		client: new Client(server.url),
		collectionKey: listOp.collection?.key ?? "widgets",
		createOp: undefined,
		deleteOp: undefined,
		effectOps: [],
		entityName: "widget",
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
	}
	expect(check?.applicable(ctx)).toBe(true)
	await check?.run(ctx)
	return { findings, requests }
}

function backendOf(findings: FindingCollector, checkId: string) {
	return findings.findings.filter((finding) => finding.check === checkId && finding.verdict === "BACKEND_BUG")
}

describe("filter.numeric-comparison-is-numeric", () => {
	const id = "filter.numeric-comparison-is-numeric"

	it("does not treat extra matching rows outside the cohort as BACKEND_BUG", async () => {
		const { findings, requests } = await runCheck(id, {
			compare: "numeric",
			store: [...COHORT, ...OUTSIDE],
		})
		expect(requests.some((url) => url.includes("filter="))).toBe(true)
		expect(backendOf(findings, id)).toEqual([])
		expect(findings.inconclusive.filter((item) => item.check === id)).toEqual([])
	})

	it("passes when the known matches are exactly the numeric gt subset", async () => {
		const { findings } = await runCheck(id, { compare: "numeric", store: [...COHORT] })
		expect(backendOf(findings, id)).toEqual([])
		expect(findings.inconclusive.filter((item) => item.check === id)).toEqual([])
	})

	it("reports a lexical miss as BACKEND_BUG titled as text compare", async () => {
		const { findings } = await runCheck(id, { compare: "lexical", store: [...COHORT] })
		const bugs = backendOf(findings, id)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).toContain(TEXT_COMPARE)
	})

	it("does not let unknown extras hide a lexical miss", async () => {
		const { findings } = await runCheck(id, {
			compare: "lexical",
			store: [...COHORT, ...OUTSIDE],
		})
		const bugs = backendOf(findings, id)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).toContain(TEXT_COMPARE)
	})

	it("reports a known identity that fails numeric gt but is listed", async () => {
		const { findings } = await runCheck(id, {
			compare: "numeric",
			includeKnownNonMatch: true,
			store: [...COHORT],
		})
		const bugs = backendOf(findings, id)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).not.toContain(TEXT_COMPARE)
	})

	it("does not title an extras-only mismatch as a text compare", async () => {
		const { findings } = await runCheck(id, {
			compare: "numeric",
			includeKnownNonMatch: true,
			store: [...COHORT, ...OUTSIDE],
		})
		const bugs = backendOf(findings, id)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).not.toContain(TEXT_COMPARE)
	})
})

describe("sibling exact-cohort filter checks", () => {
	it("filter.contains-membership ignores extra identities outside the cohort", async () => {
		const id = "filter.contains-membership"
		const { findings } = await runCheck(id, {
			compare: "numeric",
			store: [...COHORT, ...OUTSIDE],
		})
		expect(backendOf(findings, id)).toEqual([])
		expect(findings.inconclusive.filter((item) => item.check === id)).toEqual([])
	})

	it("filter.contains-membership still fails a known miss", async () => {
		const id = "filter.contains-membership"
		const { findings } = await runCheck(id, {
			compare: "numeric",
			dropKnownMatch: true,
			store: [...COHORT, ...OUTSIDE],
		})
		expect(backendOf(findings, id).length).toBeGreaterThan(0)
	})

	it("filter.is-null-selects-nulls ignores extra identities outside the cohort", async () => {
		const id = "filter.is-null-selects-nulls"
		const { findings } = await runCheck(id, {
			compare: "numeric",
			store: [...COHORT, ...OUTSIDE],
		})
		expect(backendOf(findings, id)).toEqual([])
		expect(findings.inconclusive.filter((item) => item.check === id)).toEqual([])
	})

	it("filter.is-null-selects-nulls still fails a known miss", async () => {
		const id = "filter.is-null-selects-nulls"
		const { findings } = await runCheck(id, {
			compare: "numeric",
			dropKnownMatch: true,
			store: [...COHORT, ...OUTSIDE],
		})
		expect(backendOf(findings, id).length).toBeGreaterThan(0)
	})
})
