import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * One operation that never answers, on a host that answers everything else, is that operation
 * failing, not the network going away. The run goes on and fails the operation; only a host that
 * stops answering altogether is a network outage.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const spec: OpenApiDocument = {
	info: { title: "slow", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/fine": { post: { operationId: "fine.send", responses: ok } },
		"/v1/slow": { post: { operationId: "slow.send", responses: ok } },
	},
} as OpenApiDocument

async function serve(): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url === "/v1/slow") return /* never answers */
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : { ok: true }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(
		() =>
			new Promise((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	)
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("a request that times out on a host that still answers", () => {
	it("fails that operation and lets the run finish", { timeout: 30_000 }, async () => {
		const url = await serve()
		const result = await run({
			baseUrl: url,
			network: { requestTimeoutMs: 300, retries: 0, waitMs: 1_000 },
			principals: [{ headers: {}, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.network?.incomplete ?? false).toBe(false)
		expect(result.scope.operations.find((op) => op.operationId === "slow.send")?.status).toBe("failed")
		expect(result.scope.operations.find((op) => op.operationId === "fine.send")?.status).toBe("passed")
		const slow = result.findings.find((f) => f.verdict === "BACKEND_BUG" && f.operations?.includes("slow.send"))
		expect(slow?.summary).toMatch(/did not answer/)
	})
})
