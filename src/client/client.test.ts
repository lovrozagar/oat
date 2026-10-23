import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import { Redactor } from "../security/redact.ts"
import { member, ok } from "../spec/__fixtures__/documents.ts"
import { modelOf } from "../spec/graph/__fixtures__/operations.ts"
import { operationResolver } from "../spec/graph/resolver.ts"
import { type Answer, json, refused, reset, sequence, transport } from "./__fixtures__/transport.ts"
import { fixedSource, sendingHeaders } from "./__fixtures__/source.ts"
import { Client } from "./client.ts"
import type { Actor } from "./credential-source.ts"
import type { ClientOptions } from "./types.ts"

const ANON: Actor = { anonymous: true }

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
describe("a client's transcript spool", () => {
	it("moves bodies past the memory it is given into the folder it is given, and removes them on dispose", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oat-client-spool-"))
		try {
			const { client } = clientOf(() => json({ rows: "r".repeat(64) }), { transcript: { dir, memoryBytes: 1 } })
			await client.get("/rows", { as: ANON })
			await client.get("/rows", { as: ANON })
			expect(readdirSync(dir).filter((name) => name.startsWith("oat-transcript-"))).toHaveLength(1)
			expect((await client.hydrate(client.transcript[0] as Exchange)).responseBody).toEqual({ rows: "r".repeat(64) })
			await client.dispose()
			expect(readdirSync(dir)).toEqual([])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("safe methods", () => {
	it("lets a read-only view send QUERY and OPTIONS, and counts neither as a write", async () => {
		const { client, sent } = clientOf(() => json({}))
		const reader = client.readOnlyView({ check: "search" })
		await reader.request("QUERY", "/search", { as: ANON, body: { term: "a" } })
		await reader.request("OPTIONS", "/search", { as: ANON })
		expect(sent.map((request) => [request.method, request.body])).toEqual([
			["QUERY", '{"term":"a"}'],
			["OPTIONS", undefined],
		])
		expect(client.writes).toBe(0)
		await client.request("PATCH", "/rows/1", { as: ANON, body: {} })
		expect(client.writes).toBe(1)
	})

	it("never sends TRACE, and says why", async () => {
		const { client, sent } = clientOf(() => json({}))
		await expect(client.request("trace", "/echo", { as: ANON })).rejects.toThrow(/fetch refuses TRACE/)
		expect(sent).toEqual([])
		expect(client.transcript).toEqual([])
	})
})

describe("a read-only client", () => {
	it("refuses to send anything that could change server state, through any view of it", async () => {
		const { client, sent } = clientOf(() => json({}))
		const unsafe = client.readOnlyView({ check: "sort.order-is-applied" }) as unknown as Client
		await expect(unsafe.request("POST", "/rows", { as: ANON })).rejects.toThrow(/does not mutate/)
		await expect(unsafe.view({ purpose: "probe" }).request("DELETE", "/rows/1", { as: ANON })).rejects.toThrow(
			/does not mutate/,
		)
		const unnamed = client.view({}, true)
		await expect(unnamed.request("PUT", "/rows/1", { as: ANON })).rejects.toThrow(
			'check "?" does not mutate, but sent PUT /rows/1',
		)
		expect((await unsafe.get("/rows", { as: ANON })).status).toBe(200)
		expect(sent).toHaveLength(1)
	})
})

describe("a view", () => {
	it("stamps its context, narrowed per request and per nested view", async () => {
		const { client } = clientOf(() => json({}))
		const view = client.view({ check: "list.reads", purpose: "assertion" })
		const first = await view.get("/rows", { as: ANON, context: { purpose: "probe" } })
		const nested = await view.view({ subject: "row" }).request("GET", "/rows", { as: ANON })
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
		await client.get("/rows", { as: ANON })
		await client.request("POST", "/rows", { as: ANON, body: {} })
		await client.request("HEAD", "/rows", { as: ANON })
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
		await client.get("/rows", { as: ANON })
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

describe("a request with a credential", () => {
	it("renews it once after a 401, and sends the renewal", async () => {
		const renewed = sendingHeaders({ authorization: "Bearer fresh" })
		const source = fixedSource(sendingHeaders({ authorization: "Bearer stale" }, { refresh: async () => renewed }))
		const { client, sent } = clientOf(
			(request) => json({}, request.headers.authorization === "Bearer fresh" ? 200 : 401),
			{ credentials: source },
		)
		const exchange = await client.get("/rows", { as: { principal: "alpha" } })
		expect(exchange).toMatchObject({ principal: "alpha", status: 200 })
		expect(sent.map((request) => request.headers.authorization)).toEqual(["Bearer stale", "Bearer fresh"])
		expect(client.transcript.map((item) => item.superseded ?? false)).toEqual([true, false])
	})

	it("sends the control read again when a renewal is refused too, as any request", async () => {
		const renewed = sendingHeaders({ authorization: "Bearer fresh" })
		const source = fixedSource(sendingHeaders({ authorization: "Bearer stale" }, { refresh: async () => renewed }))
		const { client, sent } = clientOf((request) => json({}, request.url.endsWith("/rows") ? 200 : 401), {
			credentials: source,
		})
		await client.get("/rows", { as: { principal: "alpha" } })
		expect((await client.get("/x", { as: { principal: "alpha" } })).status).toBe(401)
		expect(sent.map((request) => `${request.url.slice(BASE.length)} ${request.headers.authorization}`)).toEqual([
			"/rows Bearer stale",
			"/x Bearer stale",
			"/x Bearer fresh",
			"/rows Bearer stale",
		])
	})

	it("sends a probe once, whatever it is answered", async () => {
		const source = fixedSource(sendingHeaders({ authorization: "Bearer t" }))
		const { client, sent } = clientOf(() => json({}, 401), { credentials: source })
		expect((await client.get("/rows", { as: { principal: "alpha" }, probe: true })).status).toBe(401)
		expect(sent).toHaveLength(1)
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
		expect((await client.request("DELETE", "/rows/1", { as: ANON })).status).toBe(200)
		expect(limiter.implicitRule("DELETE")).toMatchObject({ source: "implicit" })
		const unpaced = clientOf(
			sequence(
				() => json({}, 429, { "retry-after": "0" }),
				() => json({}),
			),
		)
		expect((await unpaced.client.get("/rows", { as: ANON })).status).toBe(200)
	})

	it("resends a read after a network failure within its deadline", async () => {
		const flaky = transport((_sent, index) => (index === 0 ? Promise.reject(refused()) : json({})))
		const client = new Client({
			baseUrl: BASE,
			network: { deadlineMs: 60_000, fetchImpl: flaky.fetch, retries: 1 },
			redactor: new Redactor(),
		})
		expect((await client.get("/rows", { as: ANON })).status).toBe(200)
		expect(client.transcript.map((exchange) => exchange.status)).toEqual([0, 200])
	})
})

/*
 * What oat learns from an answer, a record a create made, is learned before the request returns,
 * from every view alike. The callback runs once the in-flight slot is free, so a callback that
 * reads back what it saw does not wait on the slot its own request holds.
 */
const echo: Answer = (request) => json({ path: new URL(request.url).pathname })

describe("afterExchange", () => {
	it("is awaited before the request returns, and may send its own request at maxInFlight 1", async () => {
		const { client } = clientOf(echo, { maxInFlight: 1 })
		const seen: string[] = []
		client.setAfterExchange(async (exchange) => {
			seen.push(client.relativePath(exchange.url))
			if (client.relativePath(exchange.url) === "/made") await client.get("/read-back", { as: ANON })
		})
		await client.request("POST", "/made", { as: ANON, body: {} })
		expect(seen).toEqual(["/made", "/read-back"])
	})

	it("fires for a view's requests, with the view's purpose", async () => {
		const { client } = clientOf(echo)
		const purposes: Array<string | undefined> = []
		client.setAfterExchange(async (exchange) => void purposes.push(exchange.purpose))
		await client.view({ purpose: "probe" }).get("/a", { as: ANON })
		await client.readOnlyView({ purpose: "assertion" }).get("/b", { as: ANON })
		expect(purposes).toEqual(["probe", "assertion"])
	})

	it("never fires for a request that threw", async () => {
		const { client } = clientOf(() => Promise.reject(reset()))
		let calls = 0
		client.setAfterExchange(async () => void (calls += 1))
		await expect(client.request("POST", "/broken", { as: ANON, body: {} })).rejects.toThrow(
			/^POST http:\/\/api\.test\/v1\/broken failed \(/,
		)
		expect(calls).toBe(0)
	})
})

describe("an exchange's path parameters", () => {
	it("are stamped from the operation the request resolved to, URI-decoded", async () => {
		const model = modelOf({
			"/projects/{project_id}/tables": { get: { operationId: "table.list", responses: ok(member) } },
			"/projects/{project_id}/tables/{table_id}": { get: { operationId: "table.read", responses: ok(member) } },
		})
		const { client } = clientOf(() => json({}), { operationResolver: operationResolver(model) })
		const exchange = await client.get("/projects/b/tables/t%209", { as: ANON })
		expect(exchange.pathParams).toEqual({ project_id: "b", table_id: "t 9" })
	})
})
