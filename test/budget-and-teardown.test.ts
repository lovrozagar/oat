import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { report } from "../src/report/console.ts"
import { Client } from "../src/runtime/client.ts"
import { run } from "../src/runtime/run.ts"
import { Ledger } from "../src/runtime/teardown.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

async function referenceModel(url: string) {
	const spec = (await (await fetch(`${url}/v1/openapi/spec`)).json()) as OpenApiDocument
	return buildModel(dereference(spec).doc)
}

describe("teardown", () => {
	it("removes children before the parent they live under", async () => {
		const server = await createMemoryServer()
		try {
			const model = await referenceModel(server.url)
			const headers = { authorization: "Bearer tok_alpha" }
			const owner = { headers: () => headers, id: "alpha" }
			const client = new Client(server.url)
			const table = await client.request("POST", "/v1/projects/proj_alpha/tables", { body: { name: "t" }, headers })
			const tableId = String((table.responseBody as { id: string }).id)
			const ledger = new Ledger()
			ledger.record("table", tableId, { project_id: "proj_alpha", table_id: tableId }, owner)
			for (const label of ["a", "b"]) {
				const row = await client.request("POST", `/v1/projects/proj_alpha/tables/${tableId}/rows`, {
					body: { label },
					headers,
				})
				const rowId = String((row.responseBody as { id: string }).id)
				ledger.record("row", rowId, { project_id: "proj_alpha", row_id: rowId, table_id: tableId }, owner)
			}
			const result = await ledger.unwind(model, client, () => [])
			expect(result.removed).toBe(3)
			const deletes = client.transcript.filter((exchange) => exchange.method === "DELETE").map((e) => e.url)
			expect(deletes.at(-1)).toMatch(/\/tables\/[^/]+$/)
			expect(deletes.slice(0, 2).every((url) => url.includes("/rows/"))).toBe(true)
		} finally {
			await server.close()
		}
	})
})

/* A tenant the caller left answers 403 to everything, its own delete included. */
const orgsSpec = {
	info: { title: "orgs", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/orgs": {
			post: {
				operationId: "org.create",
				responses: {
					"201": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
							},
						},
						description: "made",
					},
				},
			},
		},
		"/v1/orgs/{org_id}": {
			delete: {
				operationId: "org.delete",
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "gone" }, "403": { description: "not a member" } },
			},
			get: {
				operationId: "org.get",
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
							},
						},
						description: "ok",
					},
				},
			},
		},
	},
} as unknown as OpenApiDocument

async function serveOrgs(): Promise<{ close: () => Promise<void>; url: string }> {
	const live = new Set(["org_1"])
	const server = createServer((req, res) => {
		const id = /^\/v1\/orgs\/([^/]+)$/.exec(req.url ?? "")?.[1]
		if (req.method === "DELETE" && id !== undefined) {
			res.writeHead(live.delete(id) ? 204 : 403)
			res.end()
			return
		}
		res.writeHead(404)
		res.end()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	}
}

describe("teardown of a record the run already deleted", () => {
	it("counts it removed when the earlier delete succeeded", async () => {
		const server = await serveOrgs()
		try {
			const model = buildModel(dereference(orgsSpec).doc)
			const owner = { headers: () => ({}), id: "alpha" }
			const client = new Client(server.url)
			expect((await client.request("DELETE", "/v1/orgs/org_1", {})).status).toBe(204)
			const ledger = new Ledger()
			ledger.record("org", "org_1", { org_id: "org_1" }, owner)
			const result = await ledger.unwind(model, client, () => [])
			expect(result.failed).toEqual([])
			expect(result.removed).toBe(1)
		} finally {
			await server.close()
		}
	})

	it("still fails a refused delete nothing removed before", async () => {
		const server = await serveOrgs()
		try {
			const model = buildModel(dereference(orgsSpec).doc)
			const owner = { headers: () => ({}), id: "alpha" }
			const client = new Client(server.url)
			const ledger = new Ledger()
			ledger.record("org", "org_2", { org_id: "org_2" }, owner)
			const result = await ledger.unwind(model, client, () => [])
			expect(result.removed).toBe(0)
			expect(result.failed).toHaveLength(1)
		} finally {
			await server.close()
		}
	})
})

describe("the budget", () => {
	it("oat plan estimates requests per entity and in total", async () => {
		const server = await createMemoryServer()
		try {
			const text = report.plan(await referenceModel(server.url), false)
			expect(text).toMatch(/~req/)
			expect(text).toMatch(/~\d+ requests estimated for a full run/)
		} finally {
			await server.close()
		}
	})
})

describe("the payload catalog", () => {
	const payloadRequests = async (payloads: "full" | "per-write-path") => {
		const server = await createMemoryServer()
		try {
			const result = await run({
				baseUrl: server.url,
				/* Both write a plain string over JSON: one write path, so the second gets a subset. */
				only: ["table", "row"],
				payloads,
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			return {
				gaps: result.findings.filter((f) => f.check === "payload.string-survives" && f.verdict === "COVERAGE_GAP"),
				requests: result.client.transcript.filter((e) => e.check === "payload.string-survives").length,
			}
		} finally {
			await server.close()
		}
	}

	it("sends a subset per write path by default and says what it skipped", async () => {
		const narrowed = await payloadRequests("per-write-path")
		const full = await payloadRequests("full")
		expect(narrowed.requests).toBeGreaterThan(0)
		expect(full.requests).toBeGreaterThan(narrowed.requests)
		expect(narrowed.gaps.some((gap) => /of 159 payload cases/.test(gap.summary))).toBe(true)
		expect(full.gaps).toEqual([])
	}, 120_000)
})
