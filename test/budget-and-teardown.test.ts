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
