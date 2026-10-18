import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { runCheck } from "../../src/runtime/checks/core/run.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { Client } from "../../src/client/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import type { Record_ } from "../../src/runtime/world/records.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * Checks run side by side, and one may change a record while another reads the collection term
 * by term. A full prod run read `category.ne.general` (0 rows), then another check moved a row
 * into another category, then read `category.neq.general` (1 row), and reported the alias as
 * broken. A filter check that compares several reads must read again before blaming the backend:
 * when the same read now holds other rows, the collection moved, and nothing is concluded.
 */

const COHORT: Record_[] = [
	{ amount: 1, category: "general", id: "w1", note: "a" },
	{ amount: 5, category: "general", id: "w2", note: null },
	{ amount: 9, category: "special", id: "w3", note: "c" },
]

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

function send(res: ServerResponse, body: unknown): void {
	res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
}

function matches(row: Record_, term: string): boolean {
	const match = /^([a-z]+)\.([a-z]+)\.(.*)$/.exec(term)
	if (match === null) return true
	const [, field = "", op, raw = ""] = match
	const value = row[field]
	const list = raw.replace(/^\(|\)$/g, "").split(",")
	const number = Number(raw)
	switch (op) {
		case "eq":
			return String(value) === raw
		case "ne":
		case "neq":
			return value !== null && String(value) !== raw
		case "in":
			return list.includes(String(value))
		case "nin":
			return value !== null && !list.includes(String(value))
		case "gt":
			return typeof value === "number" && value > number
		case "lt":
			return typeof value === "number" && value < number
		case "gte":
			return typeof value === "number" && value >= number
		case "lte":
			return typeof value === "number" && value <= number
		case "is":
			return raw === "null" ? value === null : value !== null
		default:
			return false
	}
}

/* A record another check made for itself, outside the cohort, that it is about to change. */
const SCRATCH: Record_ = { amount: 7, category: "general", id: "s1", note: "x" }

/* A correct backend, and one other writer: right after the first filtered read it moves its row. */
type Move = "update" | "create" | "delete"

async function serve(after: number, move: Move): Promise<string> {
	const store = [...COHORT, SCRATCH].map((row) => ({ ...row }))
	let filtered = 0
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x")
		const filter = url.searchParams.get("filter")
		const rows = filter === null ? store : store.filter((row) => matches(row, filter))
		send(res, { widgets: rows.map((row) => ({ ...row })) })
		if (filter !== null && ++filtered === after) {
			const at = store.findIndex((row) => row.id === "s1")
			if (move === "update") Object.assign(store[at] ?? {}, { amount: 70, category: "special", note: null })
			if (move === "create") store.push({ amount: 3, category: "general", id: "s2", note: null })
			if (move === "delete") store.splice(at, 1)
		}
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function spec(): OpenApiDocument {
	const item = {
		properties: {
			amount: { type: "integer" },
			category: { type: "string" },
			id: { type: "string" },
			note: { type: ["string", "null"] },
		},
		required: ["id"],
		type: "object",
	}
	const ops = ["eq", "ne", "neq", "in", "nin", "gt", "lt", "gte", "lte", "is"]
	return {
		info: { title: "moving", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/widgets": {
				get: {
					operationId: "widget.list",
					parameters: [
						{ in: "query", name: "filter", schema: { type: "string" } },
						{ in: "query", name: "limit", schema: { default: 50, maximum: 100, minimum: 1, type: "integer" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { properties: { widgets: { items: item, type: "array" } }, type: "object" },
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "widget" },
					"x-query": {
						aliases: { ne: "neq" },
						filterable: [
							{ field: "category", ops, type: "string" },
							{ field: "amount", ops, type: "number" },
							{ field: "note", ops, type: "string" },
						],
						grammar: "postgrest",
						maxLimit: 100,
					},
				},
			},
		},
	} as unknown as OpenApiDocument
}

async function judge(checkId: string, after: number, move: Move): Promise<{ findings: string[] }> {
	const check = CHECKS.find((candidate) => candidate.id === checkId)
	if (check === undefined) throw new Error(`no check ${checkId}`)
	const model = buildModel(dereference(spec()).doc)
	const listOp = model.byOperationId.get("widget.list")
	if (listOp === undefined) throw new Error("no list")
	const findings = new FindingCollector()
	const ctx = checkContext({
		client: new Client({ baseUrl: await serve(after, move), redactor: new Redactor() }),
		collectionKey: "widgets",
		entityName: "widget",
		findings,
		listOp,
		model,
		query: listOp.query,
		records: COHORT.map((row) => ({ ...row })),
	})
	await runCheck(check, ctx)
	return { findings: findings.findings.map((finding) => `${finding.check}: ${finding.summary}`) }
}

describe("a filter check whose collection moves between its reads", () => {
	for (const id of [
		"filter.alias-matches-canonical",
		"filter.in-is-union-of-eq",
		"filter.nin-complements-in",
		"filter.ordered-triple-partitions",
		"filter.is-null-selects-nulls",
	]) {
		for (const move of ["update", "create", "delete"] as const) {
			for (const after of [1, 2, 3]) {
				it(`${id} blames nothing on the backend after a ${move} following read ${after}`, async () => {
					const { findings } = await judge(id, after, move)
					expect(findings).toEqual([])
				})
			}
		}
	}
})
