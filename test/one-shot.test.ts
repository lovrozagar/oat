import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { judgeDefect } from "../src/conformance/suite.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { run } from "../src/runtime/run.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(): OpenApiDocument {
	const ok = { "200": { description: "ok" } }
	return {
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		info: { title: "one-shot", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/health": { get: { operationId: "gateway.health", responses: ok } },
			"/v1/needs-query": {
				get: {
					operationId: "needs.query",
					parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }],
					responses: ok,
				},
			},
			"/v1/private": {
				get: { operationId: "private.read", responses: ok, security: [{ bearer: [] }] },
			},
		},
	} as OpenApiDocument
}

async function serve(healthStatus: number): Promise<{ hits: string[]; url: string }> {
	const hits: string[] = []
	const document = spec()
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const method = (req.method ?? "GET").toUpperCase()
		hits.push(`${method} ${url.pathname}`)
		if (url.pathname === "/openapi.json" && method === "GET") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(document))
			return
		}
		if (url.pathname === "/health" && method === "GET") {
			res.writeHead(healthStatus, { "content-type": "application/json" })
			res.end(JSON.stringify({ ok: healthStatus === 200 }))
			return
		}
		res.writeHead(500, { "content-type": "application/json" })
		res.end(JSON.stringify({ error: "should not have been called" }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return { hits, url }
}

async function runAt(baseUrl: string) {
	return run({
		baseUrl,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

describe("a public read with no id", () => {
	it("calls only the public read and holds its documented success", async () => {
		const { hits, url } = await serve(200)
		const result = await runAt(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		const health = result.scope.operations.find((op) => op.operationId === "gateway.health")
		expect(health?.status).toBe("held")
		expect(health?.checks.held).toContain("response.public-get-returns-success")
		expect(hits.filter((hit) => hit !== "GET /openapi.json")).toEqual(["GET /health"])
		expect(result.scope.operations.find((op) => op.operationId === "needs.query")?.status).toBe("untested")
		expect(result.scope.operations.find((op) => op.operationId === "private.read")?.status).toBe("untested")
	})

	it("reports a public read that does not return its success status", async () => {
		const { url } = await serve(500)
		const result = await runAt(url)
		const health = result.scope.operations.find((op) => op.operationId === "gateway.health")
		expect(health?.status).toBe("failed")
		expect(result.findings.map((finding) => finding.summary)).toContain(
			"a public read did not return its success status",
		)
	})

	it("the reference backend is caught only when the public read fails", async () => {
		const failed = await judgeDefect("PUBLIC_GET_NOT_SUCCESS", "memory", "postgrest")
		expect(failed.error).toBeUndefined()
		expect(failed.detected).toBe(true)
		expect(failed.spurious).toEqual([])
	}, 60_000)
})
