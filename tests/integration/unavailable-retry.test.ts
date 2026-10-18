import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/runtime/client.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A 503 that names when to come back is a cue a well-behaved client follows: wait, ask again. oat
 * does the same, within a budget; a 503 that outlasts it, or that names no wait, stands, and the
 * run fails the operation as unavailable rather than calling it a crash.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

async function serve(
	answers: Array<{ status: number; retryAfter?: string }>,
): Promise<{ hits: () => number; url: string }> {
	let hits = 0
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(spec))
			return
		}
		const answer = answers[Math.min(hits, answers.length - 1)] ?? { status: 200 }
		hits += 1
		res.writeHead(answer.status, {
			"content-type": "application/json",
			...(answer.retryAfter === undefined ? {} : { "retry-after": answer.retryAfter }),
		})
		res.end(JSON.stringify({ ok: answer.status < 400 }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return { hits: () => hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const json = { "application/json": { schema: { type: "object" } } }
const spec: OpenApiDocument = {
	info: { title: "busy", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/busy": {
			post: {
				operationId: "busy.send",
				responses: { "200": { content: json, description: "ok" }, "503": { content: json, description: "busy" } },
			},
		},
	},
} as OpenApiDocument

describe("a 503 with Retry-After", () => {
	it("is waited out and asked again, and the answer that follows is the verdict", async () => {
		const server = await serve([{ retryAfter: "1", status: 503 }, { status: 200 }])
		const client = new Client(server.url, {}, 1, () => undefined)
		const exchange = await client.request("POST", "/v1/busy")
		expect(exchange.status).toBe(200)
		expect(server.hits()).toBe(2)
		expect(client.transcript.filter((e) => e.status === 503).every((e) => e.superseded === true)).toBe(true)
	})

	it("is not asked again when it names no wait", async () => {
		const server = await serve([{ status: 503 }, { status: 200 }])
		const client = new Client(server.url, {}, 1, () => undefined)
		expect((await client.request("POST", "/v1/busy")).status).toBe(503)
		expect(server.hits()).toBe(1)
	})

	it("fails the operation as unavailable when it outlasts the wait", { timeout: 30_000 }, async () => {
		const server = await serve([{ retryAfter: "1", status: 503 }])
		const result = await run({
			baseUrl: server.url,
			principals: [{ headers: {}, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "busy.send")?.status).toBe("failed")
		const finding = result.findings.find((f) => f.verdict === "BACKEND_BUG" && f.operations?.includes("busy.send"))
		expect(finding?.summary).toMatch(/unavailable/)
		expect(server.hits()).toBeGreaterThan(1)
	})
})
