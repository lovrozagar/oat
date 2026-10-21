import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { runCheck } from "../../src/runtime/checks/core/run.ts"
import { entityChecks } from "../../src/runtime/checks/core/registry.ts"
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
 * A field a listing does not carry is no value to tie on. A public listing declared `created_at`
 * sortable but left it out of every row; oat read the rows as tied on it and blamed the second
 * key for an order the server took from a `created_at` it never showed (prod, 2026-10-16).
 */

const ROWS: Record_[] = [
	{ handle: "a", updated_at: 100 },
	{ handle: "b", updated_at: 300 },
	{ handle: "c", updated_at: 200 },
]

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

async function serve(): Promise<string> {
	/* Sorted by a creation time the rows do not show: whatever order is asked, this one comes back. */
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ profiles: ROWS }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function spec(): OpenApiDocument {
	const item = { properties: { handle: { type: "string" }, updated_at: { type: "integer" } }, type: "object" }
	return {
		info: { title: "profiles", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/profiles": {
				get: {
					operationId: "profile.list",
					parameters: [
						{ in: "query", name: "order", schema: { type: "string" } },
						{ in: "query", name: "limit", schema: { default: 50, maximum: 100, minimum: 1, type: "integer" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { properties: { profiles: { items: item, type: "array" } }, type: "object" },
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "handle", name: "profile" },
					"x-query": { grammar: "postgrest", maxLimit: 100, sortable: ["created_at", "updated_at"] },
				},
			},
		},
	} as unknown as OpenApiDocument
}

describe("sort.multi-key-tiebreak on a field the rows do not carry", () => {
	it("does not read the missing field as a tie", async () => {
		const check = entityChecks(CHECKS).find((candidate) => candidate.id === "sort.multi-key-tiebreak")
		if (check === undefined) throw new Error("no check")
		const model = buildModel(dereference(spec()).doc)
		const listOp = model.byOperationId.get("profile.list")
		if (listOp === undefined) throw new Error("no list")
		const findings = new FindingCollector()
		const ctx = checkContext({
			client: new Client({ baseUrl: await serve(), redactor: new Redactor() }),
			collectionKey: "profiles",
			entityName: "profile",
			findings,
			identity: "handle",
			listOp,
			model,
			query: listOp.query,
			records: ROWS.map((row) => ({ ...row })),
		})
		await runCheck(check, ctx)
		expect(findings.findings.map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
	})
})
