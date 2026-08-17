import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { driveAsync } from "../src/runtime/async.ts"
import { AuthRefreshRequiredError, createPrincipal, type AcquireSpec } from "../src/runtime/auth.ts"
import { Client } from "../src/runtime/client.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const SPEC = {
	info: { title: "async-refresh", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/auth/register": {
			post: {
				operationId: "auth.register",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
			},
		},
		"/v1/auth/refresh": {
			post: {
				operationId: "auth.refreshToken",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
			},
		},
		"/v1/jobs": {
			post: {
				operationId: "job.start",
				responses: { "202": { description: "accepted" } },
			},
		},
		"/v1/jobs/{id}": {
			get: {
				operationId: "job.poll",
				responses: { "200": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			if (text === "") {
				resolve(undefined)
				return
			}
			try {
				resolve(JSON.parse(text) as unknown)
			} catch (error) {
				reject(error)
			}
		})
		req.on("error", reject)
	})
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

const model = buildModel(dereference(SPEC).doc)

const signup: AcquireSpec = {
	credentialFrom: "$.access_token",
	expiresInFrom: "$.access_token_expires_in",
	refresh: {
		steps: [
			{
				body: { refresh_token: "{refreshToken}" },
				operationId: "auth.refreshToken",
				saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
			},
		],
	},
	refreshBufferMs: 30_000,
	steps: [
		{
			body: { email: "oat@example.test" },
			operationId: "auth.register",
			saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
		},
	],
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

describe("driveAsync live headers", () => {
	it("refreshes before the first poll after a POST that outlived remaining TTL", async () => {
		const refreshHits: string[] = []
		const pollAuth: string[] = []
		let polls = 0
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/auth/register" && method === "POST") {
					return send(res, 200, {
						access_token: "t1",
						access_token_expires_in: 90,
						refresh_token: "rt-1",
					})
				}
				if (url.pathname === "/v1/auth/refresh" && method === "POST") {
					const body = (await readJson(req)) as { refresh_token?: string }
					refreshHits.push(body.refresh_token ?? "")
					return send(res, 200, {
						access_token: "t2",
						access_token_expires_in: 90,
						refresh_token: "rt-2",
					})
				}
				if (url.pathname === "/v1/jobs" && method === "POST") {
					return send(res, 202, { id: "job_1" })
				}
				if (url.pathname === "/v1/jobs/job_1" && method === "GET") {
					pollAuth.push(req.headers.authorization ?? "")
					polls += 1
					return send(res, 200, { status: polls >= 2 ? "done" : "running" })
				}
				return send(res, 404)
			})()
		})
		closers.push(server.close)

		const client = new Client(server.url)
		const runtime = await createPrincipal("alpha", signup, {
			client,
			hooks: {},
			model,
			principalId: "alpha",
		})

		const start = await client.request("POST", "/v1/jobs", {
			headers: runtime.headers,
			refreshIfStale: runtime.refreshIfStale,
		})
		expect(start.status).toBe(202)
		expect(refreshHits).toEqual([])

		/* The POST itself outlived remaining TTL. Next dispatch (first poll) must refresh. */
		runtime.expiresAt = Date.now() - 1

		const outcome = await driveAsync(
			client,
			{
				idFrom: "$.id",
				poll: "GET /v1/jobs/{id}",
				pollIntervalMs: 1,
				successWhen: "status.eq.done",
				timeoutMs: 1_000,
				until: "status.eq.done",
			},
			start.responseBody,
			{},
			runtime.headers,
			runtime.refreshIfStale,
		)
		expect(outcome.succeeded).toBe(true)
		expect(refreshHits).toEqual(["rt-1"])
		expect(pollAuth).toEqual(["Bearer t2", "Bearer t2"])
	})

	it("a frozen header snapshot keeps the dead Bearer — getter is required", async () => {
		const pollAuth: string[] = []
		let polls = 0
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/auth/register" && method === "POST") {
					return send(res, 200, {
						access_token: "t1",
						access_token_expires_in: 20,
						refresh_token: "rt-1",
					})
				}
				if (url.pathname === "/v1/auth/refresh" && method === "POST") {
					return send(res, 200, {
						access_token: "t2",
						access_token_expires_in: 90,
						refresh_token: "rt-2",
					})
				}
				if (url.pathname === "/v1/jobs/job_1" && method === "GET") {
					pollAuth.push(req.headers.authorization ?? "")
					polls += 1
					return send(res, 200, { status: polls >= 2 ? "done" : "running" })
				}
				return send(res, 404)
			})()
		})
		closers.push(server.close)

		const client = new Client(server.url)
		const runtime = await createPrincipal("alpha", signup, {
			client,
			hooks: {},
			model,
			principalId: "alpha",
		})

		const frozen = runtime.headers()
		await runtime.refreshIfStale()
		expect(runtime.headers().authorization).toBe("Bearer t2")

		/* Frozen snapshot is the 0.4.0 bug: poll 2 would still send t1. */
		expect(frozen.authorization).toBe("Bearer t1")

		const outcome = await driveAsync(
			client,
			{
				idFrom: "$.id",
				poll: "GET /v1/jobs/{id}",
				pollIntervalMs: 1,
				successWhen: "status.eq.done",
				timeoutMs: 1_000,
				until: "status.eq.done",
			},
			{ id: "job_1" },
			{},
			runtime.headers,
			runtime.refreshIfStale,
		)
		expect(outcome.succeeded).toBe(true)
		expect(pollAuth).toEqual(["Bearer t2", "Bearer t2"])
		expect(pollAuth).not.toContain("Bearer t1")
	})

	it("signup without refresh still fails closed during a poll refresh", async () => {
		const server = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/v1/auth/register") {
				return send(res, 200, {
					access_token: "t1",
					access_token_expires_in: 20,
					refresh_token: "rt-1",
				})
			}
			if (url.pathname.startsWith("/v1/jobs/")) return send(res, 200, { status: "running" })
			return send(res, 404)
		})
		closers.push(server.close)

		const client = new Client(server.url)
		const runtime = await createPrincipal(
			"alpha",
			{
				credentialFrom: "$.access_token",
				expiresInFrom: "$.access_token_expires_in",
				refreshBufferMs: 30_000,
				steps: [
					{
						body: { email: "oat@example.test" },
						operationId: "auth.register",
						saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
					},
				],
			},
			{ client, hooks: {}, model, principalId: "alpha" },
		)

		await expect(
			driveAsync(
				client,
				{ idFrom: "$.id", poll: "GET /v1/jobs/{id}", pollIntervalMs: 1, timeoutMs: 200, until: "status.eq.done" },
				{ id: "job_1" },
				{},
				runtime.headers,
				runtime.refreshIfStale,
			),
		).rejects.toBeInstanceOf(AuthRefreshRequiredError)
	})
})
