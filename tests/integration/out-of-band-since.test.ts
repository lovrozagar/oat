import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OutOfBandRequest, ScenarioStep } from "../../src/config/define-config.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A value delivered outside HTTP (a mail, a code) answers the request that told the backend where
 * to deliver it. An inbox also holds what earlier requests triggered, and those can arrive late;
 * the hook is told when that request was sent, so it can pass over anything delivered before it.
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

async function askedWith(steps: ScenarioStep[]) {
	const url = await serve()
	const asked: OutOfBandRequest[] = []
	const result = await run({
		baseUrl: url,
		hooks: {
			resolveOutOfBand: (req) => {
				asked.push(req)
				return Promise.resolve("token-1")
			},
		},
		principals: [{ headers: {}, id: "alpha" }],
		scenarios: [{ covers: ["invite.accept"], id: "invite", steps }],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
	const sends = result.client.transcript.filter((exchange) => exchange.operationId === "invite.send")
	return { asked, sends }
}

const accept: ScenarioStep = { body: { token: "{token}" }, operationId: "invite.accept" }

describe("an out-of-band request", () => {
	it("carries when the request naming its address was sent", async () => {
		const { asked, sends } = await askedWith([
			{ body: { email: "beta@example.test" }, operationId: "invite.send" },
			{ outOfBand: { address: "beta@example.test", as: "token", kind: "invite" } },
			accept,
		])
		const send = sends[0]
		expect(asked).toHaveLength(1)
		expect(asked[0]?.since).toBe((send?.at ?? 0) - (send?.durationMs ?? 0))
	})

	it("is not moved by a later request to another address", async () => {
		const { asked, sends } = await askedWith([
			{ body: { email: "beta@example.test" }, operationId: "invite.send" },
			{ body: { email: "gamma@example.test" }, operationId: "invite.send" },
			{ outOfBand: { address: "beta@example.test", as: "token", kind: "invite" } },
			accept,
		])
		const toBeta = sends[0]
		expect(sends).toHaveLength(2)
		expect(asked[0]?.since).toBe((toBeta?.at ?? 0) - (toBeta?.durationMs ?? 0))
	})

	it("carries no since when no request named its address", async () => {
		const { asked } = await askedWith([
			{ operationId: "invite.send" },
			{ outOfBand: { address: "beta@example.test", as: "token", kind: "invite" } },
			accept,
		])
		expect(asked).toHaveLength(1)
		expect(asked[0]?.since).toBeUndefined()
	})

	it("carries no since for a value sent before the scenario", async () => {
		const { asked } = await askedWith([
			{ body: { email: "beta@example.test" }, operationId: "invite.send" },
			{ outOfBand: { address: "beta@example.test", as: "token", kind: "offer", sentEarlier: true } },
			accept,
		])
		expect(asked).toHaveLength(1)
		expect(asked[0]?.since).toBeUndefined()
	})
})
