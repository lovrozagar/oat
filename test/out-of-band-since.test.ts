import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OutOfBandRequest } from "../src/config/define-config.ts"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * A value delivered outside HTTP (a mail, a code) answers the request that triggered it. An inbox
 * also holds what earlier requests triggered, and those can arrive late; the hook is told when the
 * triggering request was sent, so it can pass over anything delivered before it.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const spec: OpenApiDocument = {
	info: { title: "mail", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/invite": { post: { operationId: "invite.send", responses: ok } },
		"/v1/accept": { post: { operationId: "invite.accept", responses: ok } },
	},
} as OpenApiDocument

async function serve(): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : { ok: true }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("an out-of-band request", () => {
	it("carries when the request that triggered it was sent", async () => {
		const url = await serve()
		const asked: OutOfBandRequest[] = []
		const before = Date.now()
		const result = await run({
			baseUrl: url,
			hooks: {
				resolveOutOfBand: (req) => {
					asked.push(req)
					return Promise.resolve("token-1")
				},
			},
			principals: [{ headers: {}, id: "alpha" }],
			scenarios: [
				{
					covers: ["invite.accept"],
					id: "invite",
					steps: [
						{ operationId: "invite.send" },
						{ outOfBand: { address: "beta@example.test", as: "token", kind: "invite" } },
						{ body: { token: "{token}" }, operationId: "invite.accept" },
					],
				},
			],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const send = result.client.transcript.find((exchange) => exchange.operationId === "invite.send")
		expect(asked).toHaveLength(1)
		expect(asked[0]?.since).toBeGreaterThanOrEqual(before)
		expect(asked[0]?.since).toBeLessThanOrEqual(send?.at ?? 0)
	})
})
