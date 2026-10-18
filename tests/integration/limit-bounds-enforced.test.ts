import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import { isRootCause } from "../../src/runtime/finding.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A page size out of range may be clamped or refused; both are honest contracts, so oat does not
 * pick one for an API. When the document declares `limitOutOfRange: reject`, a page size of 0 or
 * past the maximum that comes back 200 breaks that promise, and is a finding.
 */

const ITEM = { properties: { id: { type: "string" } }, required: ["id"], type: "object" }

function spec(declared: boolean): OpenApiDocument {
	return {
		info: { title: "bounded", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					parameters: [
						{ in: "query", name: "skip", schema: { default: 0, minimum: 0, type: "integer" } },
						{ in: "query", name: "take", schema: { default: 2, maximum: 3, minimum: 1, type: "integer" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { data: { items: ITEM, type: "array" }, totalCount: { type: "integer" } },
										type: "object",
									},
								},
							},
							description: "ok",
						},
						default: { description: "refused" },
					},
					"x-entity": { action: "list", identity: "id", name: "note" },
					"x-query": { maxLimit: 3, ...(declared ? { limitOutOfRange: "reject" } : {}) },
				},
			},
		},
	} as unknown as OpenApiDocument
}

const ROWS = Array.from({ length: 6 }, (_, index) => ({ id: `n${index + 1}` }))
const servers: Array<() => Promise<void>> = []
afterAll(async () => {
	await Promise.all(servers.map((close) => close()))
})

async function serve(refuses: boolean, declared: boolean): Promise<string> {
	const server = createServer((req, res) => {
		const at = new URL(req.url ?? "/", "http://x")
		if (at.pathname === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(spec(declared)))
			return
		}
		const skip = Number(at.searchParams.get("skip") ?? "0")
		const take = Number(at.searchParams.get("take") ?? "2")
		if (refuses && (take < 1 || take > 3)) {
			res.writeHead(400, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: "take out of range" }))
			return
		}
		const served = Math.min(Math.max(take, 1), 3)
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ data: ROWS.slice(skip, skip + served), totalCount: ROWS.length }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	servers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function judged(refuses: boolean, declared: boolean) {
	const url = await serve(refuses, declared)
	const result = await run({
		baseUrl: url,
		principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
	return {
		ran: result.checksRun.includes("pagination.limit-bounds-enforced"),
		found: result.findings.filter((f) => isRootCause(f) && f.check === "pagination.limit-bounds-enforced"),
	}
}

describe("pagination.limit-bounds-enforced", () => {
	it("is a finding when a declared refusal is served instead", async () => {
		const clamped = await judged(false, true)
		expect(clamped.ran).toBe(true)
		expect(clamped.found).toHaveLength(1)
	})

	it("passes when the backend refuses as declared", async () => {
		const refused = await judged(true, true)
		expect(refused.ran).toBe(true)
		expect(refused.found).toEqual([])
	})

	it("does not apply when the document declares no policy", async () => {
		expect((await judged(false, false)).ran).toBe(false)
	})
})
