import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { AuthRefreshRequiredError, createPrincipal, type AcquireSpec } from "../src/runtime/auth.ts"
import { Client } from "../src/runtime/client.ts"

interface Harness {
	url: string
	close: () => Promise<void>
	registerHits: string[]
	refreshHits: string[]
	resourceAuth: string[]
	setGetStatus: (status: number | ((n: number) => number)) => void
	delayRefreshMs: number
}

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

const SPEC = {
	info: { title: "auth-refresh", version: "1" },
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
		"/v1/auth/token": {
			post: {
				operationId: "auth.token",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
			},
		},
		"/v1/items": {
			get: {
				operationId: "item.list",
				responses: { "200": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

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

async function startAuthServer(options?: {
	expiresIn?: number
	refreshExpiresIn?: number
	plainToken?: boolean
}): Promise<Harness> {
	const registerHits: string[] = []
	const refreshHits: string[] = []
	const resourceAuth: string[] = []
	let tokenN = 0
	let getN = 0
	let getStatus: number | ((n: number) => number) = 200
	const expiresIn = options?.expiresIn ?? 90
	const refreshExpiresIn = options?.refreshExpiresIn ?? 90
	const harness: Harness = {
		close: async () => undefined,
		delayRefreshMs: 0,
		refreshHits,
		registerHits,
		resourceAuth,
		setGetStatus: (status) => {
			getStatus = status
		},
		url: "",
	}

	const issue = (kind: "acquire" | "refresh"): Record<string, unknown> => {
		tokenN += 1
		const token = options?.plainToken === true ? `plain-${tokenN}` : `${kind}-${tokenN}`
		return {
			access_token: token,
			access_token_expires_in: kind === "refresh" ? refreshExpiresIn : expiresIn,
			refresh_token: `rt-${tokenN}`,
		}
	}

	const server = await listen((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, SPEC)
			if (url.pathname === "/v1/auth/register" && method === "POST") {
				registerHits.push("register")
				return send(res, 200, issue("acquire"))
			}
			if (url.pathname === "/v1/auth/token" && method === "POST") {
				registerHits.push("token")
				return send(res, 200, issue("acquire"))
			}
			if (url.pathname === "/v1/auth/refresh" && method === "POST") {
				if (harness.delayRefreshMs > 0) await new Promise((done) => setTimeout(done, harness.delayRefreshMs))
				const body = (await readJson(req)) as { refresh_token?: string }
				refreshHits.push(body.refresh_token ?? "")
				return send(res, 200, issue("refresh"))
			}
			if (url.pathname === "/v1/items" && method === "GET") {
				resourceAuth.push(req.headers.authorization ?? "")
				getN += 1
				const status = typeof getStatus === "function" ? getStatus(getN) : getStatus
				if (status === 401) return send(res, 401, { error: "expired" })
				return send(res, 200, { items: [] })
			}
			return send(res, 404, { error: "missing" })
		})()
	})
	harness.url = server.url
	harness.close = server.close
	return harness
}

const model = buildModel(dereference(SPEC).doc)

function signupFlow(refresh: boolean): AcquireSpec {
	return {
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
		...(refresh
			? {
					refresh: {
						steps: [
							{
								body: { refresh_token: "{refreshToken}" },
								operationId: "auth.refreshToken",
								saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
							},
						],
					},
				}
			: {}),
	}
}

function tokenExchangeFlow(): AcquireSpec {
	return {
		credentialFrom: "$.access_token",
		expiresInFrom: "$.access_token_expires_in",
		refreshBufferMs: 30_000,
		steps: [{ body: { key: "k" }, operationId: "auth.token" }],
	}
}

const servers: Harness[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function principalOf(harness: Harness, spec: AcquireSpec) {
	const client = new Client(harness.url)
	const runtime = await createPrincipal("alpha", spec, {
		client,
		hooks: {},
		model,
		principalId: "alpha",
	})
	return { client, runtime }
}

describe("countdown refresh", () => {
	it("does not refresh when expiresAt is 90s out and buffer is 30s", async () => {
		const harness = await startAuthServer({ expiresIn: 90 })
		servers.push(harness)
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		expect(harness.registerHits).toEqual(["register"])
		await client.request("GET", "/v1/items", {
			headers: runtime.headers,
			refreshIfStale: runtime.refreshIfStale,
		})
		expect(harness.refreshHits).toEqual([])
		expect(harness.resourceAuth).toEqual(["Bearer acquire-1"])
	})

	it("refreshes before dispatch when expiresAt is 20s out", async () => {
		const harness = await startAuthServer({ expiresIn: 20 })
		servers.push(harness)
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		await client.request("GET", "/v1/items", {
			headers: runtime.headers,
			refreshIfStale: runtime.refreshIfStale,
		})
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toEqual(["Bearer refresh-2"])
	})

	it("signup with refresh hits auth.refreshToken, never register again", async () => {
		const harness = await startAuthServer({ expiresIn: 20 })
		servers.push(harness)
		const { runtime } = await principalOf(harness, signupFlow(true))
		await runtime.refreshIfStale()
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual(["rt-1"])
	})

	it("signup without refresh fails closed with AUTH_REFRESH_REQUIRED", async () => {
		const harness = await startAuthServer({ expiresIn: 20 })
		servers.push(harness)
		const { runtime } = await principalOf(harness, signupFlow(false))
		await expect(runtime.refreshIfStale()).rejects.toBeInstanceOf(AuthRefreshRequiredError)
		await expect(runtime.refreshIfStale()).rejects.toMatchObject({ code: "AUTH_REFRESH_REQUIRED" })
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual([])
	})

	it("single-flights overlapping refreshIfStale on one principal", async () => {
		const harness = await startAuthServer({ expiresIn: 20 })
		servers.push(harness)
		harness.delayRefreshMs = 40
		const { runtime } = await principalOf(harness, signupFlow(true))
		await Promise.all([runtime.refreshIfStale(), runtime.refreshIfStale()])
		expect(harness.refreshHits).toHaveLength(1)
		expect(runtime.headers().authorization).toBe("Bearer refresh-2")
	})

	it("retries a 401 once after a forced refresh", async () => {
		const harness = await startAuthServer({ expiresIn: 90 })
		servers.push(harness)
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		harness.setGetStatus((n) => (n === 1 ? 401 : 200))
		const exchange = await client.request("GET", "/v1/items", {
			headers: runtime.headers,
			refreshIfStale: runtime.refreshIfStale,
		})
		expect(exchange.status).toBe(200)
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toEqual(["Bearer acquire-1", "Bearer refresh-2"])
		expect(client.transcript.filter((e) => e.url.endsWith("/v1/items"))).toHaveLength(2)
	})

	it("records a second 401 and does not attempt a third request", async () => {
		const harness = await startAuthServer({ expiresIn: 90 })
		servers.push(harness)
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		harness.setGetStatus(401)
		const exchange = await client.request("GET", "/v1/items", {
			headers: runtime.headers,
			refreshIfStale: runtime.refreshIfStale,
		})
		expect(exchange.status).toBe(401)
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toHaveLength(2)
		expect(client.transcript.filter((e) => e.url.endsWith("/v1/items"))).toHaveLength(2)
	})

	it("never proactive-refreshes a principal with expiresAt === null", async () => {
		const harness = await startAuthServer({ expiresIn: 90, plainToken: true })
		servers.push(harness)
		const spec: AcquireSpec = {
			credentialFrom: "$.access_token",
			refresh: {
				steps: [
					{
						body: { refresh_token: "{refreshToken}" },
						operationId: "auth.refreshToken",
						saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
					},
				],
			},
			steps: [
				{
					body: { key: "k" },
					operationId: "auth.token",
					saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
				},
			],
		}
		const { client, runtime } = await principalOf(harness, spec)
		expect(runtime.expiresAt).toBeNull()
		await client.request("GET", "/v1/items", {
			headers: runtime.headers,
			refreshIfStale: runtime.refreshIfStale,
		})
		expect(harness.refreshHits).toEqual([])
		expect(harness.resourceAuth).toEqual(["Bearer plain-1"])
	})

	it("token-exchange without refresh re-runs steps instead of failing closed", async () => {
		const harness = await startAuthServer({ expiresIn: 20 })
		servers.push(harness)
		const { runtime } = await principalOf(harness, tokenExchangeFlow())
		await runtime.refreshIfStale()
		expect(harness.registerHits).toEqual(["token", "token"])
		expect(harness.refreshHits).toEqual([])
	})
})
