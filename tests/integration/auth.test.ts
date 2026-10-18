import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { AuthRefreshRequiredError, createPrincipal, type AcquireSpec } from "../../src/runtime/auth.ts"
import { Client } from "../../src/client/client.ts"
import { Redactor } from "../../src/security/redact.ts"

interface Harness {
	url: string
	close: () => Promise<void>
	registerHits: string[]
	refreshHits: string[]
	resourceAuth: string[]
	tokenBodies: unknown[]
	tokenWho: string[]
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

interface AuthOptions {
	expiresIn?: number
	refreshExpiresIn?: number
	plainToken?: boolean
}

type Route = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/* The token, refresh and resource endpoints, recording each hit on the harness. */
class AuthBackend {
	readonly harness: Harness
	#tokenN = 0
	#getN = 0
	#getStatus: number | ((n: number) => number) = 200
	readonly #options: AuthOptions | undefined

	constructor(options: AuthOptions | undefined) {
		this.#options = options
		this.harness = {
			close: async () => undefined,
			delayRefreshMs: 0,
			refreshHits: [],
			registerHits: [],
			resourceAuth: [],
			tokenBodies: [],
			tokenWho: [],
			setGetStatus: (status) => {
				this.#getStatus = status
			},
			url: "",
		}
	}

	#issue(kind: "acquire" | "refresh"): Record<string, unknown> {
		this.#tokenN += 1
		const token = this.#options?.plainToken === true ? `plain-${this.#tokenN}` : `${kind}-${this.#tokenN}`
		return {
			access_token: token,
			access_token_expires_in:
				kind === "refresh" ? (this.#options?.refreshExpiresIn ?? 90) : (this.#options?.expiresIn ?? 90),
			refresh_token: `rt-${this.#tokenN}`,
		}
	}

	readonly routes: Record<string, Route> = {
		"GET /v1/items": (req, res) => {
			this.harness.resourceAuth.push(req.headers.authorization ?? "")
			this.#getN += 1
			const status = typeof this.#getStatus === "function" ? this.#getStatus(this.#getN) : this.#getStatus
			if (status === 401) return send(res, 401, { error: "expired" })
			return send(res, 200, { items: [] })
		},
		"GET /v1/openapi/spec": (_req, res) => send(res, 200, SPEC),
		"POST /v1/auth/refresh": async (req, res) => {
			const delay = this.harness.delayRefreshMs
			if (delay > 0) await new Promise((done) => setTimeout(done, delay))
			const body = (await readJson(req)) as { refresh_token?: string }
			this.harness.refreshHits.push(body.refresh_token ?? "")
			return send(res, 200, this.#issue("refresh"))
		},
		"POST /v1/auth/register": (_req, res) => {
			this.harness.registerHits.push("register")
			return send(res, 200, this.#issue("acquire"))
		},
		"POST /v1/auth/token": async (req, res) => {
			this.harness.registerHits.push("token")
			this.harness.tokenBodies.push(await readJson(req))
			const who = req.headers["x-who"]
			this.harness.tokenWho.push(typeof who === "string" ? who : "")
			return send(res, 200, this.#issue("acquire"))
		},
	}
}

async function startAuthServer(options?: AuthOptions): Promise<Harness> {
	const backend = new AuthBackend(options)
	const server = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const route = backend.routes[`${(req.method ?? "GET").toUpperCase()} ${url.pathname}`]
		if (route === undefined) return send(res, 404, { error: "missing" })
		void route(req, res)
	})
	backend.harness.url = server.url
	backend.harness.close = server.close
	return backend.harness
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
	const client = new Client({ baseUrl: harness.url, redactor: new Redactor() })
	const runtime = await createPrincipal("alpha", spec, {
		client,
		hooks: {},
		model,
		principalId: "alpha",
	})
	return { client, runtime }
}

/* A started auth server, closed after the test. */
async function harnessed(options?: AuthOptions): Promise<Harness> {
	const harness = await startAuthServer(options)
	servers.push(harness)
	return harness
}

/* One resource read as the principal, refreshing first when its credential is stale. */
function getItems(client: Client, runtime: Awaited<ReturnType<typeof principalOf>>["runtime"]) {
	return client.request("GET", "/v1/items", {
		headers: runtime.headers,
		refreshIfStale: runtime.refreshIfStale,
	})
}

describe("countdown refresh", () => {
	it("does not refresh when expiresAt is 90s out and buffer is 30s", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		expect(harness.registerHits).toEqual(["register"])
		await getItems(client, runtime)
		expect(harness.refreshHits).toEqual([])
		expect(harness.resourceAuth).toEqual(["Bearer acquire-1"])
	})

	it("refreshes before dispatch when expiresAt is 20s out", async () => {
		const harness = await harnessed({ expiresIn: 20 })
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		await getItems(client, runtime)
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toEqual(["Bearer refresh-2"])
	})

	it("signup with refresh hits auth.refreshToken, never register again", async () => {
		const harness = await harnessed({ expiresIn: 20 })
		const { runtime } = await principalOf(harness, signupFlow(true))
		await runtime.refreshIfStale()
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual(["rt-1"])
	})

	it("signup without refresh fails closed with AUTH_REFRESH_REQUIRED", async () => {
		const harness = await harnessed({ expiresIn: 20 })
		const { runtime } = await principalOf(harness, signupFlow(false))
		await expect(runtime.refreshIfStale()).rejects.toBeInstanceOf(AuthRefreshRequiredError)
		await expect(runtime.refreshIfStale()).rejects.toMatchObject({ code: "AUTH_REFRESH_REQUIRED" })
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual([])
	})

	it("single-flights overlapping refreshIfStale on one principal", async () => {
		const harness = await harnessed({ expiresIn: 20 })
		harness.delayRefreshMs = 40
		const { runtime } = await principalOf(harness, signupFlow(true))
		await Promise.all([runtime.refreshIfStale(), runtime.refreshIfStale()])
		expect(harness.refreshHits).toHaveLength(1)
		expect(runtime.headers().authorization).toBe("Bearer refresh-2")
	})
})

describe("countdown refresh", () => {
	it("retries a 401 once after a forced refresh", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		harness.setGetStatus((n) => (n === 1 ? 401 : 200))
		const exchange = await getItems(client, runtime)
		expect(exchange.status).toBe(200)
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toEqual(["Bearer acquire-1", "Bearer refresh-2"])
		expect(client.transcript.filter((e) => e.url.endsWith("/v1/items"))).toHaveLength(2)
	})

	it("records a second 401 and does not attempt a third request", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const { client, runtime } = await principalOf(harness, signupFlow(true))
		harness.setGetStatus(401)
		const exchange = await getItems(client, runtime)
		expect(exchange.status).toBe(401)
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toHaveLength(2)
		expect(client.transcript.filter((e) => e.url.endsWith("/v1/items"))).toHaveLength(2)
	})

	it("never proactive-refreshes a principal with expiresAt === null", async () => {
		const harness = await harnessed({ expiresIn: 90, plainToken: true })
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
		await getItems(client, runtime)
		expect(harness.refreshHits).toEqual([])
		expect(harness.resourceAuth).toEqual(["Bearer plain-1"])
	})
})

describe("countdown refresh", () => {
	it("token-exchange without refresh re-runs steps instead of failing closed", async () => {
		const harness = await harnessed({ expiresIn: 20 })
		const { runtime } = await principalOf(harness, tokenExchangeFlow())
		await runtime.refreshIfStale()
		expect(harness.registerHits).toEqual(["token", "token"])
		expect(harness.refreshHits).toEqual([])
	})

	it("adopts a credential issued outside the auth flow without refreshing it away", async () => {
		const harness = await harnessed({ expiresIn: 20 })
		const { runtime } = await principalOf(harness, tokenExchangeFlow())
		const scope = { ...runtime.scope }
		expect(runtime.headers().authorization).toBe("Bearer acquire-1")

		runtime.adoptCredential("fresh")
		expect(runtime.credential()).toBe("fresh")
		expect(runtime.headers().authorization).toBe("Bearer fresh")
		expect(runtime.expiresAt).toBeNull()
		expect(runtime.scope).toEqual(scope)
		await runtime.refreshIfStale()
		expect(harness.registerHits).toEqual(["token"])
		expect(runtime.credential()).toBe("fresh")

		const payload = Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url")
		const jwt = `eyJhbGciOiJub25lIn0.${payload}.sig`
		runtime.adoptCredential(jwt)
		expect(runtime.credential()).toBe(jwt)
		expect(runtime.headers().authorization).toBe(`Bearer ${jwt}`)
		expect(runtime.expiresAt).toBe(4_102_444_800_000)
		expect(runtime.matches({ authorization: "Bearer acquire-1" })).toBe(true)
		expect(runtime.matches({ authorization: `Bearer ${jwt}` })).toBe(true)
		expect(runtime.matches({})).toBe(false)
		runtime.adoptCredential("")
		expect(runtime.credential()).toBe(jwt)
		expect(runtime.scope).toEqual(scope)
	})

	it("interpolates nested bodies, arrays, and non-strings", async () => {
		const harness = await harnessed()
		const spec: AcquireSpec = {
			credentialFrom: "$.access_token",
			steps: [
				{
					bind: { who: "oat" },
					body: { empty: null, meta: { name: "{who}" }, n: 1, ok: true, tags: ["{who}", 2] },
					headers: { "x-who": "{who}" },
					operationId: "auth.token",
					query: { q: "{who}" },
				},
			],
		}
		const { runtime } = await principalOf(harness, spec)
		expect(harness.tokenBodies).toEqual([{ empty: null, meta: { name: "oat" }, n: 1, ok: true, tags: ["oat", 2] }])
		expect(harness.tokenWho).toEqual(["oat"])
		expect(runtime.credential()).toBe("acquire-1")
	})
})
