import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { judgeDefect } from "../../src/conformance/matrix/cases.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import { listening } from "../../src/conformance/harness/launch.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])
const ROW = { id: "art_1", name: "Alpha" }

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(): OpenApiDocument {
	const article = {
		properties: { id: { type: "string" }, name: { type: "string" } },
		required: ["id", "name"],
		type: "object",
	}
	const ok = {
		"200": {
			content: { "application/json": { schema: article } },
			description: "ok",
		},
	}
	return {
		info: { title: "list-only", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/articles": {
				get: {
					operationId: "article.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { articles: { items: article, type: "array" } },
										required: ["articles"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "article" },
				},
			},
			"/v1/articles/{id}": {
				get: {
					operationId: "article.get",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					responses: ok,
					"x-entity": { action: "read", identity: "id", name: "article" },
				},
			},
		},
	} as OpenApiDocument
}

async function serve(rows: Array<typeof ROW>): Promise<string> {
	const document = spec()
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const method = (req.method ?? "GET").toUpperCase()
		if (url.pathname === "/openapi.json" && method === "GET") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(document))
			return
		}
		if (url.pathname === "/v1/articles" && method === "GET") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ articles: rows }))
			return
		}
		const item = url.pathname.match(/^\/v1\/articles\/([^/]+)$/)
		if (item !== null && method === "GET") {
			const row = rows.find((candidate) => candidate.id === decodeURIComponent(item[1] ?? ""))
			res.writeHead(row === undefined ? 404 : 200, { "content-type": "application/json" })
			res.end(JSON.stringify(row ?? { error: "missing" }))
			return
		}
		res.writeHead(404, { "content-type": "application/json" })
		res.end(JSON.stringify({ error: "missing" }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

async function runAt(baseUrl: string) {
	return run({
		baseUrl,
		principals: { alpha: {} },
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

describe("a list with no create", () => {
	it("holds the get when the list already has that row", async () => {
		const url = await serve([ROW])
		const result = await runAt(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		const get = result.scope.operations.find((op) => op.operationId === "article.get")
		expect(get?.status).toBe("passed")
		expect(get?.checks.passed).toContain("list.item-matches-listed-row")
		const item = result.client.transcript.find(
			(exchange) => exchange.method === "GET" && exchange.url.includes("/v1/articles/art_1"),
		)
		expect(item?.responseBody).toEqual(ROW)
	})

	it("grades the list and leaves the get untested when the list is empty", async () => {
		const url = await serve([])
		const result = await runAt(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		const list = result.scope.operations.find((op) => op.operationId === "article.list")
		const get = result.scope.operations.find((op) => op.operationId === "article.get")
		expect(list?.status).toBe("passed")
		expect(get?.status).toBe("untested")
		expect(get?.reason).toBe("the list returned no id")
	})

	it("the reference backend is caught when the get body is not the listed row", async () => {
		const failed = await judgeDefect("LISTED_GET_DIFFERS", { backend: "memory", dialect: "postgrest", via: listening })
		expect(failed.error).toBeUndefined()
		expect(failed.detected).toBe(true)
		expect(failed.spurious).toEqual([])
	}, 60_000)
})
