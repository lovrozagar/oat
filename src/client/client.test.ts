import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { RateLimiter } from "../runtime/rate-limit.ts"
import { Redactor } from "../security/redact.ts"
import { type Answer, json, refused, sequence, transport } from "./__fixtures__/transport.ts"
import { Client } from "./client.ts"
import { AuthRefreshError } from "./refresh.ts"
import type { ClientOptions } from "./types.ts"

const BASE = "http://api.test/v1"

function clientOf(
	answer: Answer,
	more: Partial<ClientOptions> = {},
): { client: Client; sent: ReturnType<typeof transport>["sent"] } {
	const wire = transport(answer)
	const client = new Client({ baseUrl: BASE, network: { fetchImpl: wire.fetch }, redactor: new Redactor(), ...more })
	return { client, sent: wire.sent }
}

/*
 * Read-only checks run together, through a client that cannot write: one that changed server
 * state would move the cohort under every other check in its batch.
 */
describe("a read-only client", () => {
	it("refuses to send anything that could change server state, through any view of it", async () => {
		const { client, sent } = clientOf(() => json({}))
		const unsafe = client.readOnlyView({ check: "sort.order-is-applied" }) as unknown as Client
		await expect(unsafe.request("POST", "/rows")).rejects.toThrow(/does not mutate/)
		await expect(unsafe.view({ purpose: "probe" }).request("DELETE", "/rows/1")).rejects.toThrow(/does not mutate/)
		const unnamed = client.view({}, true)
		await expect(unnamed.request("PUT", "/rows/1")).rejects.toThrow('check "?" does not mutate, but sent PUT /rows/1')
		expect((await unsafe.get("/rows")).status).toBe(200)
		expect(sent).toHaveLength(1)
	})
})

describe("a view", () => {
	it("stamps its context, narrowed per request and per nested view", async () => {
		const { client } = clientOf(() => json({}))
		const view = client.view({ check: "list.reads", purpose: "assertion" })
		const first = await view.get("/rows", { context: { purpose: "probe" } })
		const nested = await view.view({ subject: "row" }).request("GET", "/rows")
		expect(first).toMatchObject({ check: "list.reads", purpose: "probe" })
		expect(nested).toMatchObject({ check: "list.reads", purpose: "assertion", subject: "row" })
		expect(view.transcript).toBe(client.transcript)
	})
})

describe("a client", () => {
	it("records every exchange, indexed by operation and entity, and counts its writes", async () => {
		const { client } = clientOf(() => json({}), {
			operationResolver: (method) =>
				method === "POST" ? null : { entity: "row", operationId: "row.list", template: "/rows" },
		})
		await client.get("/rows")
		await client.request("POST", "/rows", { body: {} })
		await client.request("HEAD", "/rows")
		expect(client.transcript.map((exchange) => exchange.method)).toEqual(["GET", "POST", "HEAD"])
		expect(client.exchangesFor("row.list")).toHaveLength(2)
		expect(client.exchangesForEntity("row")).toHaveLength(2)
		expect(client.writes).toBe(1)
		expect(await client.hydrate(client.transcript[0] as Exchange)).toBe(client.transcript[0])
		await client.dispose()
	})

	it("hands each answer to onExchange and afterExchange, and scrubs with its redactor", async () => {
		const redactor = new Redactor()
		const seen: string[] = []
		const { client } = clientOf(() => json({}), {
			onExchange: (exchange) => void seen.push(`on ${exchange.seq}`),
			redactor,
		})
		client.setAfterExchange(async (exchange) => void seen.push(`after ${exchange.seq}`))
		await client.get("/rows")
		expect(seen).toEqual(["on 1", "after 1"])
		expect(client.redactor).toBe(redactor)
	})

	it("reads paths below its base, wherever the base sits", () => {
		const { client } = clientOf(() => json({}))
		expect(client.relativePath(`${BASE}/rows/1`)).toBe("/rows/1")
		expect(client.relativePath(new URL(`${BASE}`))).toBe("/")
		expect(client.relativePath("http://api.test/v2/rows")).toBe("/v2/rows")
		const root = new Client({ baseUrl: "http://api.test", redactor: new Redactor() })
		expect(root.relativePath("http://api.test/rows")).toBe("/rows")
	})
})

const bound = (log: string[], token: { value: string }) => ({
	credentialFor: () => ({
		headers: () => ({ authorization: `Bearer ${token.value}` }),
		refreshIfStale: async (force?: boolean) => {
			log.push(`refresh ${String(force)}`)
			if (force === true) token.value = "fresh"
		},
	}),
	principalOf: () => "alpha",
})

describe("a request with a credential", () => {
	it("refreshes when stale, and once more after a 401, sending the fresh credential", async () => {
		const log: string[] = []
		const token = { value: "stale" }
		const { client, sent } = clientOf(
			(request) => json({}, request.headers.authorization === "Bearer fresh" ? 200 : 401),
			{
				credentials: bound(log, token),
			},
		)
		const exchange = await client.get("/rows")
		expect(exchange.status).toBe(200)
		expect(log).toEqual(["refresh false", "refresh true"])
		expect(sent.map((request) => request.headers.authorization)).toEqual(["Bearer stale", "Bearer fresh"])
		expect(client.transcript.map((item) => item.superseded ?? false)).toEqual([true, false])
	})

	it("uses the caller's own refresh, and none when told to skip it", async () => {
		const log: string[] = []
		const { client } = clientOf(() => json({}), { credentials: bound(log, { value: "t" }) })
		await client.get("/rows", { refreshIfStale: async () => void log.push("caller") })
		await client.get("/rows", { skipAuthRefresh: true })
		const bare = clientOf(() => json({}))
		await bare.client.get("/rows")
		expect(log).toEqual(["caller"])
	})

	it("raises a failed refresh as the principal's", async () => {
		const { client } = clientOf(() => json({}), {
			credentials: {
				credentialFor: () => ({ headers: () => ({}), refreshIfStale: () => Promise.reject(new Error("token 500")) }),
				principalOf: () => "alpha",
			},
		})
		await expect(client.get("/rows")).rejects.toEqual(new AuthRefreshError("alpha", new Error("token 500")))
		const unbound = clientOf(() => json({}))
		const failing = unbound.client.get("/rows", { refreshIfStale: () => Promise.reject(new Error("down")) })
		await expect(failing).rejects.toMatchObject({ principal: undefined })
	})
})

describe("a request the backend pushes back on", () => {
	it("tells the rate limiter about a 429 and asks again", async () => {
		const limiter = new RateLimiter([])
		const { client } = clientOf(
			sequence(
				() => json({}, 429, { "retry-after": "0" }),
				() => json({}),
			),
			{
				rateLimiter: limiter,
			},
		)
		expect((await client.request("DELETE", "/rows/1")).status).toBe(200)
		expect(limiter.implicitRule("DELETE")).toMatchObject({ source: "implicit" })
		const unpaced = clientOf(
			sequence(
				() => json({}, 429, { "retry-after": "0" }),
				() => json({}),
			),
		)
		expect((await unpaced.client.get("/rows")).status).toBe(200)
	})

	it("resends a read after a network failure within its deadline", async () => {
		const flaky = transport((_sent, index) => (index === 0 ? Promise.reject(refused()) : json({})))
		const client = new Client({
			baseUrl: BASE,
			network: { deadlineMs: 60_000, fetchImpl: flaky.fetch, retries: 1 },
			redactor: new Redactor(),
		})
		expect((await client.get("/rows")).status).toBe(200)
		expect(client.transcript.map((exchange) => exchange.status)).toEqual([0, 200])
	})
})
