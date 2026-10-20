import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { buildRateLimitRules } from "../../src/runtime/rate-limit/rules.ts"
import {
	MAX_429_RETRIES,
	parseRetryAfter,
	RETRY_BACKOFF_CAP_MS,
	RETRY_BACKOFF_INITIAL_MS,
	retryWaitMs,
} from "../../src/runtime/rate-limit/retry-after.ts"
import { RateLimiter, UNTAGGED_WRITE_CATEGORY } from "../../src/runtime/rate-limit/limiter.ts"
import { run } from "../../src/runtime/run/index.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

/* A JSON answer, or a bare status; headers a test sets on `res` first go out with it. */
function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, {
		"content-length": String(Buffer.byteLength(text)),
		"content-type": "application/json",
	})
	res.end(text)
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	close: () => Promise<void>
	url: string
}> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

const ITEM = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function thingSpec(rateLimit: { category: string; rps?: number } | null): OpenApiDocument {
	const create: Record<string, unknown> = {
		operationId: "thing.create",
		requestBody: {
			content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
			required: true,
		},
		responses: {
			"201": { content: { "application/json": { schema: ITEM } }, description: "created" },
		},
		"x-entity": { action: "create", identity: "id", name: "thing" },
	}
	if (rateLimit !== null) create["x-rate-limit"] = rateLimit
	return {
		info: { title: "rate-limit", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/things": {
				get: {
					operationId: "thing.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { items: { items: ITEM, type: "array" } },
										required: ["items"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "thing" },
				},
				post: create,
			},
			"/v1/things/{id}": {
				delete: {
					operationId: "thing.delete",
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", identity: "id", name: "thing" },
				},
				get: {
					operationId: "thing.read",
					responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "thing" },
				},
			},
		},
	} as OpenApiDocument
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

describe("Retry-After parsing", () => {
	it("reads delta-seconds", () => {
		expect(parseRetryAfter("1")).toBe(1000)
		expect(parseRetryAfter("2.5")).toBe(2500)
		expect(parseRetryAfter("0")).toBe(0)
	})

	it("reads HTTP-date", () => {
		const now = Date.UTC(2026, 7, 17, 12, 0, 0)
		expect(parseRetryAfter("Mon, 17 Aug 2026 12:00:04 GMT", now)).toBe(4000)
	})

	it("caps and rejects junk", () => {
		expect(parseRetryAfter("3600")).toBe(RETRY_BACKOFF_CAP_MS)
		expect(parseRetryAfter("nope")).toBeNull()
		expect(parseRetryAfter(undefined)).toBeNull()
	})

	it("falls back to exponential backoff capped at 30s", () => {
		expect(retryWaitMs(undefined, 0)).toBe(RETRY_BACKOFF_INITIAL_MS)
		expect(retryWaitMs(undefined, 1)).toBe(2_000)
		expect(retryWaitMs(undefined, 2)).toBe(4_000)
		expect(retryWaitMs(undefined, 5)).toBe(RETRY_BACKOFF_CAP_MS)
		expect(retryWaitMs("1", 0)).toBe(1000)
		expect(MAX_429_RETRIES).toBe(5)
	})
})

/* A thing endpoint that answers the first POST 429 with `headers`, then creates. */
async function throttledOnce(headers?: Record<string, string>) {
	let posts = 0
	const server = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname !== "/v1/things" || req.method !== "POST") return send(res, 404)
		posts += 1
		if (posts === 1) {
			for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value)
			return send(res, 429, { error: "too_many_requests" })
		}
		return send(res, 201, { id: "t1", name: "n" })
	})
	closers.push(server.close)
	return { posts: () => posts, server }
}

type ThingWorld = { posts: number; rows: Map<string, { id: string; name: string }>; spec: OpenApiDocument }

/* The first create is throttled with a zero wait; the rest succeed. */
function createThing(world: ThingWorld, res: ServerResponse): void {
	world.posts += 1
	if (world.posts === 1) {
		res.setHeader("retry-after", "0")
		return send(res, 429, { error: "too_many_requests" })
	}
	const id = `t_${String(world.posts)}`
	const row = { id, name: "n" }
	world.rows.set(id, row)
	send(res, 201, row)
}

/* The item a request names, and its method. */
interface ItemRequest {
	id: string
	method: string
}

function thingItem(world: ThingWorld, { id, method }: ItemRequest, res: ServerResponse): void {
	if (method === "GET") {
		const row = world.rows.get(id)
		return row === undefined ? send(res, 404) : send(res, 200, row)
	}
	if (method !== "DELETE") return send(res, 404)
	world.rows.delete(id)
	send(res, 204)
}

/* A full thing backend for a run. */
async function routeThings(world: ThingWorld, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")
	const method = (req.method ?? "GET").toUpperCase()
	if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, world.spec)
	if (url.pathname === "/v1/things" && method === "GET") return send(res, 200, { items: [...world.rows.values()] })
	if (url.pathname === "/v1/things" && method === "POST") return createThing(world, res)
	const item = /^\/v1\/things\/([^/]+)$/.exec(url.pathname)
	if (item === null) return send(res, 404)
	thingItem(world, { id: item[1] ?? "", method }, res)
}

/* A run against the thing backend, seeding through its throttled first create. */
async function runThrottledSeed() {
	const world: ThingWorld = { posts: 0, rows: new Map(), spec: thingSpec(null) }
	const server = await listen((req, res) => {
		void routeThings(world, req, res)
	})
	closers.push(server.close)
	const result = await run({
		baseUrl: server.url,
		keepFixtures: true,
		only: ["thing"],
		principals: { alpha: {} },
		seed: 1,
		spec: `${server.url}/v1/openapi/spec`,
	})
	return { result, world }
}

describe("Client.request 429 retry", () => {
	it("retries once after Retry-After: 1 and returns the 201, not the 429", async () => {
		const { posts, server } = await throttledOnce({ "retry-after": "1" })
		const client = new Client({ baseUrl: server.url, redactor: new Redactor() })
		const started = Date.now()
		const exchange = await client.request("POST", "/v1/things", { as: { anonymous: true }, body: { name: "n" } })
		const elapsed = Date.now() - started
		expect(posts()).toBe(2)
		expect(exchange.status).toBe(201)
		expect(exchange.responseBody).toEqual({ id: "t1", name: "n" })
		expect(client.transcript.map((e) => e.status)).toEqual([429, 201])
		expect(elapsed).toBeGreaterThanOrEqual(900)
	})

	it("retries a 429 when the operation has no x-rate-limit", async () => {
		const spec = thingSpec(null)
		const model = buildModel(dereference(spec).doc)
		expect(model.byOperationId.get("thing.create")?.rateLimit).toBeNull()
		const rules = buildRateLimitRules(model, undefined)
		expect(rules).toEqual([])

		const { posts, server } = await throttledOnce({ "retry-after": "1" })
		const client = new Client({
			baseUrl: server.url,
			maxInFlight: 4,
			rateLimiter: new RateLimiter(rules),
			redactor: new Redactor(),
		})
		const exchange = await client.request("POST", "/v1/things", { as: { anonymous: true }, body: { name: "n" } })
		expect(posts()).toBe(2)
		expect(exchange.status).toBe(201)
		expect(client.transcript[0]?.rateLimitCategory).toBeUndefined()
		expect(client.transcript[1]?.rateLimitCategory).toBe(UNTAGGED_WRITE_CATEGORY)
		expect(client.transcript[1]?.rateLimitSource).toBe("implicit")
	})

	it("waits and retries when 429 has no Retry-After", async () => {
		const { posts, server } = await throttledOnce()
		const client = new Client({ baseUrl: server.url, redactor: new Redactor() })
		const started = Date.now()
		const exchange = await client.request("POST", "/v1/things", { as: { anonymous: true }, body: { name: "n" } })
		expect(posts()).toBe(2)
		expect(exchange.status).toBe(201)
		expect(Date.now() - started).toBeGreaterThanOrEqual(900)
	})

	it("does not treat the first 429 as a seed failure", { timeout: 20_000 }, async () => {
		const { result, world } = await runThrottledSeed()
		const blocked = result.findings.filter((f) => f.verdict === "BLOCKED" && f.check === "world.seed")
		expect(blocked).toEqual([])
		expect(result.entitiesTested).toContain("thing")
		expect(world.posts).toBeGreaterThan(1)
		expect(result.client.transcript.some((e) => e.method === "POST" && e.status === 429)).toBe(true)
		expect(result.client.transcript.some((e) => e.method === "POST" && e.status === 201)).toBe(true)
	})
})

describe("rate-limit rules for a documented operation", () => {
	it("match the operation the client stamped, not the path", () => {
		const model = buildModel(dereference(thingSpec({ category: "writes", rps: 2 })).doc)
		const [rule] = buildRateLimitRules(model, undefined)
		expect(rule?.test("POST", "/v1/things", "thing.create")).toBe(true)
		/* Behind a base path the request path no longer looks like the template; the stamp still says which operation it was. */
		expect(rule?.test("POST", "/api/v1/things", "thing.create")).toBe(true)
		expect(rule?.test("POST", "/v1/things", "other.op")).toBe(false)
		/* Unresolved, as for an absolute URL: method and path are all there is. */
		expect(rule?.test("POST", "/v1/things")).toBe(true)
	})
})
