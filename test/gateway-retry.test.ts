import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../src/runtime/client.ts"

/*
 * A gateway in front of an API answers 502, 503 or 504 now and then without the request ever
 * reaching it: a full prod run read one such page (`GET /organizations` → 502) as the scenario's
 * failure while the API logged a 200 for the same request. A read is safe to ask again, so a
 * gateway status on GET or HEAD is asked once more; one that persists stands, and a write is
 * never repeated.
 */

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

async function serve(statuses: number[]): Promise<{ url: string; hits: () => number }> {
	let hits = 0
	const server = createServer((_req, res) => {
		const status = statuses[Math.min(hits, statuses.length - 1)] ?? 200
		hits += 1
		res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: status < 400 }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return { hits: () => hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe("a gateway status on a read", () => {
	it("is asked once more, and the answer that follows is the verdict", async () => {
		const server = await serve([502, 200])
		const client = new Client(server.url)
		const exchange = await client.get("/v1/things")
		expect(exchange.status).toBe(200)
		expect(server.hits()).toBe(2)
		expect(client.transcript[0]?.superseded).toBe(true)
	})

	it("stands when it persists", async () => {
		const server = await serve([504, 504, 200])
		const exchange = await new Client(server.url).get("/v1/things")
		expect(exchange.status).toBe(504)
		expect(server.hits()).toBe(2)
	})

	it("is never repeated for a write", async () => {
		const server = await serve([502, 200])
		const exchange = await new Client(server.url).request("POST", "/v1/things", { body: { a: 1 } })
		expect(exchange.status).toBe(502)
		expect(server.hits()).toBe(1)
	})
})
