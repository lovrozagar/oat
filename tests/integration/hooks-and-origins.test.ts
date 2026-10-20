import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import type { Resolution } from "../../src/client/credential-source.ts"
import { bearerSecurity } from "../../src/conformance/harness/security.ts"
import type { Hooks } from "../../src/config/types/hooks.ts"
import type { Recipe } from "../../src/config/types/security.ts"
import type { CredentialPorts, StepRunner } from "../../src/credentials/ports.ts"
import { recipeKind } from "../../src/credentials/recipes/acquire.ts"
import { type CredentialStore, createStore } from "../../src/credentials/store.ts"
import { run } from "../../src/runtime/run/index.ts"
import { resolveOutOfBandValue } from "../../src/runtime/steps/out-of-band.ts"
import { stepRunner } from "../../src/runtime/steps/runner.ts"
import { Redactor } from "../../src/security/redact.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

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

/* Items need a bearer token; registering is public. */
const AUTH_SPEC = {
	...bearerSecurity(),
	info: { title: "hooks", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/auth/register": {
			post: {
				operationId: "auth.register",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
				security: [],
			},
		},
		"/v1/items": {
			get: { operationId: "item.list", responses: { "200": { description: "ok" } } },
		},
	},
} as OpenApiDocument

const unused = async (): Promise<never> => {
	throw new Error("this recipe sends nothing through this port")
}

/* What a store needs beyond its recipe: a step runner and the credential hook, else ports that refuse. */
interface StoreParts {
	steps?: StepRunner
	resolveCredential?: Hooks["resolveCredential"]
	/** The store's clock. Default: the system clock. */
	now?: () => number
}

/* A store holding alpha's bearer credential by `recipe`, over AUTH_SPEC's schemes. */
function storeOf(recipe: Recipe, parts: StoreParts = {}): CredentialStore {
	const { now, resolveCredential, steps } = parts
	const ports: CredentialPorts = {
		operations: { call: unused },
		steps: steps ?? { run: unused },
		tokens: { post: unused },
		...(resolveCredential === undefined ? {} : { resolveCredential }),
	}
	const { schemes } = buildModel(dereference(AUTH_SPEC).doc)
	return createStore({
		...(now === undefined ? {} : { now }),
		ports,
		principals: { alpha: {} },
		schemes,
		security: { bearer: recipe },
	})
}

const ALPHA = { principal: "alpha", scheme: "bearer" }

describe("resolveOutOfBand backoff", () => {
	it("requires the hook and retries null / empty", async () => {
		await expect(
			resolveOutOfBandValue(undefined, "a@x.test", { kind: "email-verify", label: 'principal "a"' }),
		).rejects.toThrow(/no resolveOutOfBand hook/)

		let n = 0
		const value = await resolveOutOfBandValue(
			async ({ attempt, kind, address }) => {
				expect(kind).toBe("email-verify")
				expect(address).toBe("a@x.test")
				n = attempt
				return attempt < 3 ? (attempt === 1 ? null : "") : "tok"
			},
			"a@x.test",
			{ kind: "email-verify", label: 'principal "a"', outOfBand: { attempts: 4, initialMs: 1, maxMs: 1 } },
		)
		expect(value).toBe("tok")
		expect(n).toBe(3)

		await expect(
			resolveOutOfBandValue(async () => null, "a@x.test", {
				kind: "email-verify",
				label: 'principal "a"',
				outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
			}),
		).rejects.toThrow(/after 2 attempts/)
	})
})

describe("hooks.resolveCredential", () => {
	it("distinguishes a hooked recipe from a login's steps", () => {
		expect(recipeKind({ hook: true })).toBe("hook")
		expect(recipeKind({ login: { from: "$.t", steps: [{ method: "POST", path: "/x" }] } })).toBe("login")
	})

	it("requires the hook, and BLOCKS a principal it gives no credential", async () => {
		expect(await storeOf({ hook: true }).acquire(ALPHA)).toEqual({
			blocked: expect.stringMatching(/sets no hooks\.resolveCredential/),
		})
		const none = storeOf({ hook: true }, { resolveCredential: async () => null })
		expect(await none.acquire(ALPHA)).toEqual({ blocked: expect.stringMatching(/gave no credential for "alpha"/) })
		const given = storeOf({ hook: true }, { resolveCredential: async () => ({ expiresIn: 90, value: "tok" }) })
		expect(await given.acquire(ALPHA)).toMatchObject({ value: "tok" })
	})

	it("acquires from the hook and renews by calling it again", async () => {
		let n = 0
		let now = Date.now()
		const store = storeOf(
			{ hook: true },
			{
				now: () => now,
				resolveCredential: async (scheme, principal) => {
					expect([scheme, principal.id]).toEqual(["bearer", "alpha"])
					n += 1
					return n === 1 ? { expiresIn: 1, value: "first" } : { expiresIn: 90, value: "second" }
				},
			},
		)
		expect(await store.acquire(ALPHA)).toMatchObject({ value: "first" })
		now += 1_000
		expect(await store.acquire(ALPHA)).toMatchObject({ value: "second" })
		/* A 401 on what it sent renews it once more, by the hook. */
		expect(await store.refresh({ ...ALPHA, sentValue: "second" })).toMatchObject({ value: "second" })
		expect(n).toBe(3)
	})

	it("does not proactive-refresh when expiry is unknown", async () => {
		let n = 0
		const store = storeOf(
			{ hook: true },
			{
				resolveCredential: async () => {
					n += 1
					return "static"
				},
			},
		)
		expect(await store.acquire(ALPHA)).toMatchObject({ expiresAt: null, value: "static" })
		await store.acquire(ALPHA)
		expect(n).toBe(1)
	})
})

describe("resolveHeaders", () => {
	it("merges after globalHeaders and before auth", async () => {
		const seen: string[] = []
		const server = await listen((req, res) => {
			seen.push(
				`${req.headers["x-global"] ?? ""}|${req.headers["cf-turnstile-response"] ?? ""}|${req.headers.authorization ?? ""}`,
			)
			send(res, 200, { items: [] })
		})
		closers.push(server.close)
		const live: Resolution = {
			block: () => undefined,
			kind: "sends",
			principal: "alpha",
			refresh: async () => live,
			schemes: ["bearer"],
			secrets: { cookies: [], headers: ["authorization"], query: [], values: ["Bearer live"] },
			sends: { bearer: { cookies: {}, headers: { authorization: "Bearer live" }, query: {} } },
			sentValues: { bearer: "live" },
		}
		const client = new Client({
			baseUrl: server.url,
			credentials: { resolve: async () => live },
			headers: { "x-global": "g" },
			redactor: new Redactor(),
			resolveHeaders: async ({ method, url, operationId }) => {
				expect(method).toBe("GET")
				expect(url).toContain("/v1/items")
				expect(operationId).toBe("item.list")
				return { "cf-turnstile-response": "fresh" }
			},
		})
		await client.get("/v1/items", { as: { principal: "alpha" }, operationId: "item.list" })
		expect(seen).toEqual(["g|fresh|Bearer live"])
	})

	it("treats a null hook return as no extra headers", async () => {
		const server = await listen((_req, res) => send(res, 200, {}))
		closers.push(server.close)
		const client = new Client({ baseUrl: server.url, redactor: new Redactor(), resolveHeaders: async () => null })
		const exchange = await client.get("/v1/items", { as: { anonymous: true } })
		expect(exchange.status).toBe(200)
	})
})

const CDN_TOKEN_SPEC = {
	info: { title: "cdn", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/token": {
			post: {
				operationId: "cdn.token",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

/* A server that answers only `/openapi`, with `spec`. */
async function specServer(spec: OpenApiDocument) {
	const server = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi") return send(res, 200, spec)
		send(res, 404)
	})
	closers.push(server.close)
	return server
}

/* A spec titled `title` with one entity, listed under `key` at `/v1/<key>` and created there. */
function entitySpec(title: string, entity: string, key: string): OpenApiDocument {
	const row = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
	const list = {
		properties: { [key]: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" } },
		type: "object",
	}
	return {
		info: { title, version: "1" },
		openapi: "3.1.0",
		paths: {
			[`/v1/${key}`]: {
				get: {
					operationId: `${entity}.list`,
					responses: { "200": { content: { "application/json": { schema: list } }, description: "ok" } },
					"x-entity": { action: "list", identity: "id", name: entity },
				},
				post: {
					operationId: `${entity}.create`,
					requestBody: {
						content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
					},
					responses: { "201": { content: { "application/json": { schema: row } }, description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: entity },
				},
			},
		},
	} as OpenApiDocument
}

/* A backend serving `spec` and one collection at `/v1/<key>`, ids `<prefix><n>`; returns its rows. */
async function collectionServer(spec: OpenApiDocument, key: string, prefix: string) {
	const rows: Array<{ id: string; name: string }> = []
	const server = await listen((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi") return send(res, 200, spec)
			if (url.pathname === `/v1/${key}` && method === "GET") return send(res, 200, { [key]: [...rows] })
			if (url.pathname === `/v1/${key}` && method === "POST") {
				const body = (await readJson(req)) as { name?: string }
				const row = { id: `${prefix}${rows.length + 1}`, name: body.name ?? prefix }
				rows.push(row)
				return send(res, 201, row)
			}
			return send(res, 404)
		})()
	})
	closers.push(server.close)
	return { rows, url: server.url }
}

describe("origins and auth-step origin", () => {
	it("sends an auth hop to a named origin", async () => {
		const cdnHits: string[] = []
		const cdn = await listen((req, res) => {
			cdnHits.push(`${req.method} ${req.url}`)
			send(res, 200, { access_token: "from-cdn" })
		})
		closers.push(cdn.close)
		const api = await specServer(AUTH_SPEC)
		await specServer(CDN_TOKEN_SPEC)

		const model = buildModel(dereference(AUTH_SPEC).doc)
		const originModel = buildModel(dereference(CDN_TOKEN_SPEC).doc)
		const originClient = new Client({ baseUrl: cdn.url, redactor: new Redactor() })
		const steps = stepRunner({
			client: new Client({ baseUrl: api.url, redactor: new Redactor() }),
			hooks: {},
			model,
			originClients: new Map([["cdn", { client: originClient, model: originModel }]]),
		})
		const hop: Recipe = {
			login: { from: "$.access_token", steps: [{ body: {}, operationId: "cdn.token", origin: "cdn" }] },
		}
		const held = await storeOf(hop, { steps }).acquire(ALPHA)
		expect(held).toMatchObject({ value: "from-cdn" })
		expect("sends" in held ? Object.values(held.sends.headers) : []).toEqual(["Bearer from-cdn"])
		expect(cdnHits.some((hit) => hit.startsWith("POST"))).toBe(true)

		const astray: Recipe = {
			login: { from: "$.access_token", steps: [{ method: "POST", origin: "missing", path: "/x" }] },
		}
		expect(await storeOf(astray, { steps }).acquire(ALPHA)).toEqual({
			blocked: expect.stringMatching(/not in config\.origins/),
		})
	})
})

describe("origins and auth-step origin", () => {
	it("runs a secondary origin after primary auth and stamps findings", async () => {
		const api = await collectionServer(entitySpec("api", "note", "notes"), "notes", "n")
		const cdn = await collectionServer(entitySpec("cdn", "file", "files"), "files", "f")

		const result = await run({
			baseUrl: api.url,
			origins: [{ baseUrl: cdn.url, id: "cdn", spec: `${cdn.url}/openapi` }],
			principals: { alpha: {} },
			seed: 1,
			spec: `${api.url}/openapi`,
		})
		expect(result.entitiesTested.some((name) => name === "note" || name.endsWith(":file") || name === "cdn:file")).toBe(
			true,
		)
		expect(result.principals[0]).toMatchObject({ credentials: [], id: "alpha" })
		expect(cdn.rows.length).toBeGreaterThan(0)
	})
})
