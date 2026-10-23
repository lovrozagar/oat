import { describe, expect, it } from "vitest"
import { Redactor } from "../security/redact.ts"
import { type Answer, json, reset, transport } from "./__fixtures__/transport.ts"
import { Client } from "./client.ts"
import type { Actor } from "./credential-source.ts"
import type { NetworkClientOptions } from "./types.ts"

/* When the client asks again: only a request that is safe to repeat, and only once past a gateway. */

const ANON: Actor = { anonymous: true }

function clientOf(answer: Answer, network: NetworkClientOptions = {}): { client: Client; hits: () => number } {
	const wire = transport(answer)
	const client = new Client({
		baseUrl: "http://api.test",
		network: { ...network, fetchImpl: wire.fetch },
		redactor: new Redactor(),
	})
	return { client, hits: () => wire.sent.length }
}

/* A connection dropped mid-request: the request may well have been processed. */
const dropped: Answer = () => Promise.reject(reset())

describe("a connection that breaks mid-request", () => {
	it("is never asked again for a POST", async () => {
		const { client, hits } = clientOf(dropped, { retries: 3 })
		await expect(client.request("POST", "/reset", { as: ANON, body: { a: 1 } })).rejects.toThrow(
			/^POST http:\/\/api\.test\/reset failed \(reset: the connection was reset\)$/,
		)
		expect(hits()).toBe(1)
	})

	it("is asked again for a GET, which is safe to repeat", async () => {
		const { client, hits } = clientOf(dropped, { retries: 1 })
		await expect(client.get("/reset", { as: ANON })).rejects.toThrow(
			/^GET http:\/\/api\.test\/reset failed \(reset: the connection was reset\)$/,
		)
		expect(hits()).toBe(2)
	})
})

/* Each call answers the next status in `statuses`; the last repeats. */
const statuses =
	(...codes: number[]): Answer =>
	(_sent, index) => {
		const status = codes[Math.min(index, codes.length - 1)] ?? 200
		return json({ ok: status < 400 }, status)
	}

/*
 * A gateway in front of an API answers 502, 503 or 504 now and then without the request ever
 * reaching it: a full prod run read one such page (`GET /organizations` → 502) as the scenario's
 * failure while the API logged a 200 for the same request. A read is safe to ask again, so a
 * gateway status on GET or HEAD is asked once more; one that persists stands, and a write is
 * never repeated.
 */
describe("a gateway status on a read", () => {
	it("is asked once more, and the answer that follows is the verdict", async () => {
		const { client, hits } = clientOf(statuses(502, 200))
		const exchange = await client.get("/v1/things", { as: ANON })
		expect(exchange.status).toBe(200)
		expect(hits()).toBe(2)
		expect(client.transcript[0]?.superseded).toBe(true)
	})

	it("stands when it persists", async () => {
		const { client, hits } = clientOf(statuses(504, 504, 200))
		expect((await client.get("/v1/things", { as: ANON })).status).toBe(504)
		expect(hits()).toBe(2)
	})

	it("is never repeated for a write", async () => {
		const { client, hits } = clientOf(statuses(502, 200))
		expect((await client.request("POST", "/v1/things", { as: ANON, body: { a: 1 } })).status).toBe(502)
		expect(hits()).toBe(1)
	})
})
