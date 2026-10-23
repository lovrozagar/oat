import { signupOf } from "../../src/credentials/signup.ts"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { createCredentialSource } from "../../src/client/credentials.ts"
import { bearerSecurity } from "../../src/conformance/harness/security.ts"
import type { PrincipalsConfig, Recipe, SecurityConfig } from "../../src/config/types/security.ts"
import type { CredentialPorts, StepRunner } from "../../src/credentials/ports.ts"
import { type CredentialStore, createStore, type Held } from "../../src/credentials/store.ts"
import { stepRunner } from "../../src/runtime/steps/runner.ts"
import { Redactor } from "../../src/security/redact.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { operationResolver } from "../../src/spec/graph/resolver.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A principal's login credential over its lifetime, as a run holds it: signed in once through the
 * step engine, renewed ahead of expiry or after a 401 by its declared refresh, once however many
 * requests need it, and replaced by a credential the run is handed.
 */

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

/* Items need alpha's bearer token; signing in and refreshing are public. */
const SPEC = {
	...bearerSecurity(),
	info: { title: "auth-refresh", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/auth/register": {
			post: {
				operationId: "auth.register",
				"x-fresh-principal": true,
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
				security: [],
			},
		},
		"/v1/auth/refresh": {
			post: {
				operationId: "auth.refreshToken",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
				security: [],
			},
		},
		"/v1/auth/token": {
			post: {
				operationId: "auth.token",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
				security: [],
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

/* The register answer's refresh token, saved so the declared refresh can send it. */
const SAVE_REFRESH = { refresh_token: "$.refresh_token" }

/* Signs up by auth.register; its lifetime is the answer's `access_token_expires_in`. */
function signupRecipe(refresh: boolean): Recipe {
	return {
		expiresIn: { from: "$.access_token_expires_in" },
		login: {
			from: "$.access_token",
			steps: [{ body: { email: "oat@example.test" }, operationId: "auth.register", saveAs: SAVE_REFRESH }],
		},
		...(refresh
			? {
					refresh: {
						from: "$.access_token",
						steps: [
							{ body: { refresh_token: "{refresh_token}" }, operationId: "auth.refreshToken", saveAs: SAVE_REFRESH },
						],
					},
				}
			: {}),
	}
}

function tokenExchangeRecipe(): Recipe {
	return {
		expiresIn: { from: "$.access_token_expires_in" },
		login: { from: "$.access_token", steps: [{ body: { key: "k" }, operationId: "auth.token" }] },
	}
}

const servers: Harness[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()))
})

/* A started auth server, closed after the test. */
async function harnessed(options?: AuthOptions): Promise<Harness> {
	const harness = await startAuthServer(options)
	servers.push(harness)
	return harness
}

interface Stack {
	client: Client
	store: CredentialStore
	/** Moves the store's clock on: a credential issued 90 s out is 20 s out after `pass(70_000)`. */
	pass: (ms: number) => void
}

const unused = async (): Promise<never> => {
	throw new Error("no recipe here mints a credential or posts a token form")
}

/*
 * What a run builds for alpha's bearer `recipe`: a client whose source resolves alpha over a store,
 * whose login and refresh steps run through the step engine on that same client.
 */
function stackOf(harness: Harness, recipe: Recipe): Stack {
	const security: SecurityConfig = { bearer: recipe }
	const principals: PrincipalsConfig = { alpha: {} }
	const wired: { client?: Client } = {}
	const steps = (): StepRunner =>
		stepRunner({ client: (wired.client as Client).view({ purpose: "auth" }), hooks: {}, model })
	const ports: CredentialPorts = {
		operations: { call: unused },
		records: { gone: unused, removed: () => false },
		steps: { run: (list, at) => steps().run(list, at) },
		secrets: { register: () => undefined },
		tokens: { post: unused },
	}
	let now = Date.now()
	const store = createStore({ now: () => now, ports, principals, schemes: model.schemes, security, ...signupOf(model) })
	wired.client = new Client({
		baseUrl: harness.url,
		credentials: createCredentialSource({ model, principals, security, store }),
		operationResolver: operationResolver(model),
		redactor: new Redactor(),
	})
	return {
		client: wired.client,
		pass: (ms) => {
			now += ms
		},
		store,
	}
}

const ALPHA = { principal: "alpha", scheme: "bearer" }

/* alpha's bearer credential as the store holds it now, renewed first when it is stale. */
async function held(stack: Stack): Promise<Held> {
	return stack.store.acquire(ALPHA)
}

/* What 90 s of lifetime has left once 70 s passed: inside the 30 s renewal buffer. */
const TO_20S_OUT = 70_000

/* alpha signed in, and then the clock moved on until its credential is 20 s from lapsing. */
async function twentySecondsOut(stack: Stack): Promise<void> {
	await held(stack)
	stack.pass(TO_20S_OUT)
}

/* One resource read as alpha. */
function getItems(client: Client) {
	return client.request("GET", "/v1/items", { as: { principal: "alpha" } })
}

describe("countdown refresh", () => {
	it("does not refresh when expiresAt is 90s out and buffer is 30s", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const { client } = stackOf(harness, signupRecipe(true))
		await getItems(client)
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual([])
		expect(harness.resourceAuth).toEqual(["Bearer acquire-1"])
	})

	it("refreshes before dispatch when expiresAt is 20s out", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const stack = stackOf(harness, signupRecipe(true))
		await twentySecondsOut(stack)
		await getItems(stack.client)
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toEqual(["Bearer refresh-2"])
	})

	it("signup with refresh hits auth.refreshToken, never register again", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const stack = stackOf(harness, signupRecipe(true))
		await twentySecondsOut(stack)
		await held(stack)
		stack.pass(TO_20S_OUT)
		await held(stack)
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual(["rt-1", "rt-2"])
	})

	it("signup without refresh fails closed: BLOCKED, never a second signup", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const stack = stackOf(harness, signupRecipe(false))
		await twentySecondsOut(stack)
		expect(await held(stack)).toMatchObject({ blocked: expect.stringContaining("refresh") })
		expect(await held(stack)).toMatchObject({ blocked: expect.stringContaining("refresh") })
		expect(harness.registerHits).toEqual(["register"])
		expect(harness.refreshHits).toEqual([])
	})

	it("single-flights overlapping renewals of one principal's credential", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		harness.delayRefreshMs = 40
		const stack = stackOf(harness, signupRecipe(true))
		await twentySecondsOut(stack)
		await Promise.all([getItems(stack.client), getItems(stack.client)])
		expect(harness.refreshHits).toHaveLength(1)
		expect(harness.resourceAuth).toEqual(["Bearer refresh-2", "Bearer refresh-2"])
	})
})

describe("countdown refresh", () => {
	it("retries a 401 once after a forced refresh", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const { client } = stackOf(harness, signupRecipe(true))
		harness.setGetStatus((n) => (n === 1 ? 401 : 200))
		const exchange = await getItems(client)
		expect(exchange.status).toBe(200)
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toEqual(["Bearer acquire-1", "Bearer refresh-2"])
		expect(client.transcript.filter((e) => e.url.endsWith("/v1/items"))).toHaveLength(2)
	})

	it("records a second 401 and does not attempt a third request", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const { client } = stackOf(harness, signupRecipe(true))
		harness.setGetStatus(401)
		const exchange = await getItems(client)
		expect(exchange.status).toBe(401)
		expect(harness.refreshHits).toEqual(["rt-1"])
		expect(harness.resourceAuth).toHaveLength(2)
		expect(client.transcript.filter((e) => e.url.endsWith("/v1/items"))).toHaveLength(2)
	})

	it("never proactive-refreshes a credential with no lifetime", async () => {
		const harness = await harnessed({ expiresIn: 90, plainToken: true })
		const recipe: Recipe = {
			login: {
				from: "$.access_token",
				steps: [{ body: { key: "k" }, operationId: "auth.token", saveAs: SAVE_REFRESH }],
			},
			refresh: {
				from: "$.access_token",
				steps: [{ body: { refresh_token: "{refresh_token}" }, operationId: "auth.refreshToken", saveAs: SAVE_REFRESH }],
			},
		}
		const stack = stackOf(harness, recipe)
		expect(await held(stack)).toMatchObject({ expiresAt: null, value: "plain-1" })
		await getItems(stack.client)
		expect(harness.refreshHits).toEqual([])
		expect(harness.resourceAuth).toEqual(["Bearer plain-1"])
	})
})

describe("countdown refresh", () => {
	it("token-exchange without refresh re-runs steps instead of failing closed", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const stack = stackOf(harness, tokenExchangeRecipe())
		await twentySecondsOut(stack)
		expect(await held(stack)).toMatchObject({ value: "acquire-2" })
		expect(harness.registerHits).toEqual(["token", "token"])
		expect(harness.refreshHits).toEqual([])
	})

	it("adopts a credential issued outside the login without refreshing it away", async () => {
		const harness = await harnessed({ expiresIn: 90 })
		const stack = stackOf(harness, tokenExchangeRecipe())
		expect(await held(stack)).toMatchObject({ value: "acquire-1" })

		await stack.store.adopt({ ...ALPHA, value: "fresh" })
		expect(await held(stack)).toMatchObject({ expiresAt: null, value: "fresh" })
		await getItems(stack.client)
		expect(harness.registerHits).toEqual(["token"])
		expect(harness.resourceAuth).toEqual(["Bearer fresh"])

		const payload = Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url")
		const jwt = `eyJhbGciOiJub25lIn0.${payload}.sig`
		await stack.store.adopt({ ...ALPHA, value: jwt })
		expect(await held(stack)).toMatchObject({ expiresAt: 4_102_444_800_000, value: jwt })
		/* An empty value is no credential: what was held stays. */
		await stack.store.adopt({ ...ALPHA, value: "" })
		expect(await held(stack)).toMatchObject({ value: jwt })
		expect(harness.registerHits).toEqual(["token"])
	})

	it("interpolates nested bodies, arrays, and non-strings", async () => {
		const harness = await harnessed()
		const recipe: Recipe = {
			login: {
				from: "$.access_token",
				steps: [
					{
						bind: { who: "oat" },
						body: { empty: null, meta: { name: "{who}" }, n: 1, ok: true, tags: ["{who}", 2] },
						headers: { "x-who": "{who}" },
						operationId: "auth.token",
						query: { q: "{who}" },
					},
				],
			},
		}
		const stack = stackOf(harness, recipe)
		expect(await held(stack)).toMatchObject({ value: "acquire-1" })
		expect(harness.tokenBodies).toEqual([{ empty: null, meta: { name: "oat" }, n: 1, ok: true, tags: ["oat", 2] }])
		expect(harness.tokenWho).toEqual(["oat"])
	})
})
