import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { configProblems } from "../../src/config/validate.ts"
import { Client } from "../../src/client/client.ts"
import { buildRateLimitRules, RateLimiter } from "../../src/runtime/rate-limit.ts"
import { run } from "../../src/runtime/run/index.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * An edge in front of an API (a CDN or firewall) often limits each client IP across every route.
 * No route declares it, and a run that trips it is blocked whole. `maxRps` is that ceiling: every
 * request to the origin shares it, on top of whatever each route declares for itself.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

async function serve(spec: OpenApiDocument): Promise<{ hits: number[]; url: string }> {
	const hits: number[] = []
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url !== "/openapi.json") hits.push(performance.now())
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : { status: "ok" }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/* The most requests that landed inside any one-second window. */
function peakPerSecond(hits: number[]): number {
	const sorted = [...hits].sort((a, b) => a - b)
	let peak = 0
	for (let i = 0, j = 0; i < sorted.length; i++) {
		while ((sorted[i] as number) - (sorted[j] as number) >= 1000) j++
		peak = Math.max(peak, i - j + 1)
	}
	return peak
}

const pingSpec = (rateLimit?: Record<string, unknown>): OpenApiDocument =>
	({
		info: { title: "edge", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/ping": {
				get: {
					operationId: "ping.get",
					responses: ok,
					...(rateLimit === undefined ? {} : { "x-rate-limit": rateLimit }),
				},
			},
		},
	}) as OpenApiDocument

describe("maxRps", () => {
	it("paces every request to the origin, whatever route it is", async () => {
		const spec = pingSpec()
		const { hits, url } = await serve(spec)
		const limiter = new RateLimiter(buildRateLimitRules(buildModel(dereference(spec).doc), []), { maxRps: 4 })
		const client = new Client({
			baseUrl: url,
			headers: {},
			maxInFlight: 16,
			onExchange: () => undefined,
			rateLimiter: limiter,
			redactor: new Redactor(),
		})
		const started = performance.now()
		await Promise.all(Array.from({ length: 12 }, () => client.request("GET", "/v1/ping")))
		/* A burst of 4, then 4 a second: the last of 12 leaves no sooner than two seconds in. */
		expect(performance.now() - started).toBeGreaterThanOrEqual(1_900)
		expect(peakPerSecond(hits)).toBeLessThanOrEqual(8)
	})

	it("keeps a stricter limit a route declares", async () => {
		const spec = pingSpec({ category: "ping", rps: 2 })
		const { url } = await serve(spec)
		const limiter = new RateLimiter(buildRateLimitRules(buildModel(dereference(spec).doc), []), { maxRps: 100 })
		const client = new Client({
			baseUrl: url,
			headers: {},
			maxInFlight: 16,
			onExchange: () => undefined,
			rateLimiter: limiter,
			redactor: new Redactor(),
		})
		const started = performance.now()
		await Promise.all(Array.from({ length: 6 }, () => client.request("GET", "/v1/ping", { operationId: "ping.get" })))
		expect(performance.now() - started).toBeGreaterThanOrEqual(1_900)
	})

	it("holds a whole run under the ceiling", { timeout: 60_000 }, async () => {
		const spec = {
			...pingSpec(),
			paths: Object.fromEntries(
				Array.from({ length: 12 }, (_, i) => [`/v1/r${i}`, { get: { operationId: `r${i}.get`, responses: ok } }]),
			),
		} as OpenApiDocument
		const { hits, url } = await serve(spec)
		await run({
			baseUrl: url,
			maxInFlight: 16,
			maxRps: 3,
			principals: [{ headers: {}, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(hits.length).toBeGreaterThan(9)
		expect(peakPerSecond(hits)).toBeLessThanOrEqual(6)
	})

	it("is a positive number in config, for the main origin and each secondary one", () => {
		const base = { baseUrl: "http://127.0.0.1:1", principals: [{ id: "a" }], spec: "openapi.json" }
		expect(
			configProblems({ ...base, maxRps: 15, origins: [{ baseUrl: "x", id: "cdn", maxRps: 5, spec: "y" }] }),
		).toEqual([])
		expect(configProblems({ ...base, maxRps: 0 })).toEqual(["config.maxRps must be a number above 0"])
	})
})
