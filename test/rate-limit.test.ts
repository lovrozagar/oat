import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../src/runtime/client.ts"
import {
	buildRateLimitRules,
	MAX_429_RETRIES,
	parseRetryAfter,
	RateLimiter,
	RETRY_BACKOFF_CAP_MS,
	RETRY_BACKOFF_INITIAL_MS,
	retryWaitMs,
	UNTAGGED_WRITE_CATEGORY,
} from "../src/runtime/rate-limit.ts"
import { run } from "../src/runtime/run.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

function send(res: ServerResponse, status: number, body?: unknown, extraHeaders?: Record<string, string>): void {
	if (body === undefined) {
		res.writeHead(status, extraHeaders)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, {
		"content-length": String(Buffer.byteLength(text)),
		"content-type": "application/json",
		...extraHeaders,
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

describe("Client.request 429 retry", () => {
	it("retries once after Retry-After: 1 and returns the 201, not the 429", async () => {
		let posts = 0
		const server = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname !== "/v1/things" || req.method !== "POST") return send(res, 404)
			posts += 1
			if (posts === 1) return send(res, 429, { error: "too_many_requests" }, { "retry-after": "1" })
			return send(res, 201, { id: "t1", name: "n" })
		})
		closers.push(server.close)
		const client = new Client(server.url)
		const started = Date.now()
		const exchange = await client.request("POST", "/v1/things", { body: { name: "n" } })
		const elapsed = Date.now() - started
		expect(posts).toBe(2)
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

		let posts = 0
		const server = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname !== "/v1/things" || req.method !== "POST") return send(res, 404)
			posts += 1
			if (posts === 1) return send(res, 429, { error: "too_many_requests" }, { "retry-after": "1" })
			return send(res, 201, { id: "t1", name: "n" })
		})
		closers.push(server.close)
		const client = new Client(server.url, {}, 4, undefined, new RateLimiter(rules))
		const exchange = await client.request("POST", "/v1/things", { body: { name: "n" } })
		expect(posts).toBe(2)
		expect(exchange.status).toBe(201)
		expect(client.transcript[0]?.rateLimitCategory).toBeUndefined()
		expect(client.transcript[1]?.rateLimitCategory).toBe(UNTAGGED_WRITE_CATEGORY)
		expect(client.transcript[1]?.rateLimitSource).toBe("implicit")
	})

	it("waits and retries when 429 has no Retry-After", async () => {
		let posts = 0
		const server = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname !== "/v1/things" || req.method !== "POST") return send(res, 404)
			posts += 1
			if (posts === 1) return send(res, 429, { error: "too_many_requests" })
			return send(res, 201, { id: "t1", name: "n" })
		})
		closers.push(server.close)
		const client = new Client(server.url)
		const started = Date.now()
		const exchange = await client.request("POST", "/v1/things", { body: { name: "n" } })
		expect(posts).toBe(2)
		expect(exchange.status).toBe(201)
		expect(Date.now() - started).toBeGreaterThanOrEqual(900)
	})

	it("does not treat the first 429 as a seed failure", { timeout: 20_000 }, async () => {
		let posts = 0
		const spec = thingSpec(null)
		const rows = new Map<string, { id: string; name: string }>()
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
				if (url.pathname === "/v1/things" && method === "GET") return send(res, 200, { items: [...rows.values()] })
				if (url.pathname === "/v1/things" && method === "POST") {
					posts += 1
					if (posts === 1) return send(res, 429, { error: "too_many_requests" }, { "retry-after": "0" })
					const id = `t_${String(posts)}`
					const row = { id, name: "n" }
					rows.set(id, row)
					return send(res, 201, row)
				}
				const item = /^\/v1\/things\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") {
					const row = rows.get(item[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				if (item !== null && method === "DELETE") {
					rows.delete(item[1] ?? "")
					return send(res, 204)
				}
				return send(res, 404)
			})()
		})
		closers.push(server.close)
		const result = await run({
			baseUrl: server.url,
			keepFixtures: true,
			only: ["thing"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const blocked = result.findings.filter((f) => f.verdict === "BLOCKED" && f.check === "world.seed")
		expect(blocked).toEqual([])
		expect(result.entitiesTested).toContain("thing")
		expect(posts).toBeGreaterThan(1)
		expect(result.client.transcript.some((e) => e.method === "POST" && e.status === 429)).toBe(true)
		expect(result.client.transcript.some((e) => e.method === "POST" && e.status === 201)).toBe(true)
	})
})
