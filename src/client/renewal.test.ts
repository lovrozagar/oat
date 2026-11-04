import { afterEach, describe, expect, it, vi } from "vitest"
import type { SecurityConfig } from "../config/types/security.ts"
import type { CredentialPorts } from "../credentials/ports.ts"
import { createStore } from "../credentials/store.ts"
import type { FenceRequest } from "../config/types/hooks.ts"
import { Fence } from "../runtime/fence.ts"
import { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import { Redactor } from "../security/redact.ts"
import { buildModel } from "../spec/graph/build.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { json, transport } from "./__fixtures__/transport.ts"
import { Client } from "./client.ts"
import { type Resolution, UnsatisfiedSecurity } from "./credential-source.ts"
import { createCredentialSource } from "./credentials.ts"

/* A principal whose renewal fails: the refusal stands, and nothing more is sent for it. */

/* A backend that refuses every request, as an expired session would be. */
function expired(): { fetch: typeof fetch; hits: () => number } {
	const wire = transport(() => json({}, 401))
	return { fetch: wire.fetch, hits: () => wire.sent.length }
}

/* One secured operation the backend answers 401. */
const EXPIRED_DOC = {
	components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } },
	info: { title: "expired", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/expired": {
			get: { operationId: "expired.get", responses: { "401": { description: "expired" } }, security: [{ jwt: [] }] },
		},
	},
} as unknown as OpenApiDocument

/* A jwt with a login and a refresh of its own. */
const RENEWABLE: SecurityConfig = {
	jwt: {
		login: { from: "$.token", steps: [{ operationId: "auth.login" }] },
		refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
	},
}

const unexpected = (what: string) => Promise.reject(new Error(`unexpected ${what}`))

/* Ports whose first login issues a token, and whose every later step (the refresh, the fallback login) is refused. */
function renewalRefused(steps: string[]): CredentialPorts {
	return {
		operations: { call: () => unexpected("call") },
		records: { gone: () => unexpected("read"), removed: () => false },
		steps: {
			run: async (run) => {
				const step = run.map((one) => ("operationId" in one ? one.operationId : "?")).join(",")
				steps.push(step)
				if (steps.length > 1) throw new Error(`${step} answered 401`)
				return { answer: { body: { token: "token-1" }, cookies: {}, headers: {}, status: 200 }, scope: {} }
			},
		},
		secrets: { register: () => undefined },
		tokens: { post: () => unexpected("post") },
	}
}

describe("a principal whose renewal fails", () => {
	it("answers the refusal as it is when its renewal fails, and sends nothing more", async () => {
		let resolved = 0
		const sending: Resolution = {
			block: () => undefined,
			kind: "sends",
			lapsed: () => false,
			principal: "alpha",
			refresh: async () => ({
				kind: "blocked",
				reason: "alpha's refresh for bearer failed: refresh endpoint said 500",
			}),
			schemes: ["bearer"],
			secrets: { cookies: [], headers: ["authorization"], query: [], values: ["Bearer stale"] },
			sends: { bearer: { cookies: {}, headers: { authorization: "Bearer stale" }, query: {} } },
			sentValues: { bearer: "stale" },
		}
		const backend = expired()
		const client = new Client({
			baseUrl: "http://api.test",
			credentials: {
				resolve: async () => {
					resolved += 1
					return sending
				},
			},
			network: { fetchImpl: backend.fetch },
			redactor: new Redactor(),
		})
		const refused = await client.get("/expired", { as: { principal: "alpha" } })
		expect(refused.status).toBe(401)
		expect([backend.hits(), resolved]).toEqual([1, 1])
	})

	it("blocks its principal through the real store: the next request is refused before it is sent", async () => {
		const steps: string[] = []
		const model = buildModel(EXPIRED_DOC)
		const principals = { alpha: {} }
		const store = createStore({ ports: renewalRefused(steps), principals, schemes: model.schemes, security: RENEWABLE })
		const backend = expired()
		const client = new Client({
			baseUrl: "http://api.test",
			credentials: createCredentialSource({ model, principals, security: RENEWABLE, store }),
			network: { fetchImpl: backend.fetch },
			operationResolver: (method, path) =>
				method === "GET" && path === "/expired" ? { operationId: "expired.get", template: path } : null,
			redactor: new Redactor(),
		})
		expect((await client.get("/expired", { as: { principal: "alpha" } })).status).toBe(401)
		expect([backend.hits(), steps]).toEqual([1, ["auth.login", "auth.refresh", "auth.login"]])
		const next = client.get("/expired", { as: { principal: "alpha" } })
		await expect(next).rejects.toBeInstanceOf(UnsatisfiedSecurity)
		await expect(next).rejects.toMatchObject({
			kind: "blocked",
			reason:
				"renewal for alpha/jwt: the refresh failed (auth.refresh answered 401), then acquiring afresh failed (auth.login answered 401)",
		})
		expect(backend.hits()).toBe(1)
	})
})

/* A row the backend deletes, as alpha's bearer, and the refresh its jwt renews by. */
const ROWS_DOC = {
	components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } },
	info: { title: "rows", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/auth/session": {
			get: { operationId: "auth.session", responses: { "200": { description: "a session" } }, security: [] },
		},
		"/items": {
			get: { operationId: "item.list", responses: { "200": { description: "items" } }, security: [{ jwt: [] }] },
		},
		"/rows/{id}": {
			delete: { operationId: "row.delete", responses: { "200": { description: "gone" } }, security: [{ jwt: [] }] },
		},
	},
} as unknown as OpenApiDocument

/* A jwt that lives 300 s, issued by a login and renewed by a refresh. */
const SHORT_LIVED: SecurityConfig = {
	jwt: {
		expiresIn: 300,
		login: { from: "$.token", steps: [{ operationId: "auth.login" }] },
		refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
	},
}

const HOLD_MS = 400_000

/* The Authorization a request carried, whatever its case. */
const bearerOf = (headers: Record<string, string>): string =>
	Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? ""

/* Ports that issue token-1, token-2, … one per login or refresh; `through` sends each step's request when given. */
function issuing(through?: () => Promise<unknown>): CredentialPorts {
	let issued = 0
	return {
		operations: { call: () => unexpected("call") },
		records: { gone: () => unexpected("read"), removed: () => false },
		steps: {
			run: async () => {
				await through?.()
				issued += 1
				return { answer: { body: { token: `token-${issued}` }, cookies: {}, headers: {}, status: 200 }, scope: {} }
			},
		},
		secrets: { register: () => undefined },
		tokens: { post: () => unexpected("post") },
	}
}

const ROUTES: Record<string, string> = {
	"DELETE /rows/1": "row.delete",
	"DELETE /rows/2": "row.delete",
	"GET /auth/session": "auth.session",
	"GET /items": "item.list",
}

interface Held {
	client: Client
	limiter: RateLimiter
	fenced: string[]
	sent: () => string[]
}

/* alpha's client over the real store, with a limiter, a fence that records what it saw, and `answer` as the backend. */
function heldClient(
	answer: (index: number, limiter: RateLimiter) => Response,
	opts: { maxInFlight?: number; refreshThrough?: boolean } = {},
): Held {
	const model = buildModel(ROWS_DOC)
	const principals = { alpha: {} }
	const fenced: string[] = []
	const limiter = new RateLimiter([], { random: () => 0 })
	const wire = transport((_, index) => answer(index, limiter))
	let client: Client | undefined
	const through =
		opts.refreshThrough === true
			? () => (client as Client).request("GET", "/auth/session", { as: { anonymous: true } })
			: undefined
	const store = createStore({
		now: () => Date.now(),
		ports: issuing(through),
		principals,
		schemes: model.schemes,
		security: SHORT_LIVED,
	})
	client = new Client({
		baseUrl: "http://api.test",
		credentials: createCredentialSource({ model, principals, security: SHORT_LIVED, store }),
		fence: new Fence((request: FenceRequest) => {
			fenced.push(bearerOf(request.headers))
			return { allow: true }
		}),
		maxInFlight: opts.maxInFlight ?? 4,
		network: { fetchImpl: wire.fetch },
		operationResolver: (method, path) => {
			const operationId = ROUTES[`${method} ${path}`]
			return operationId === undefined ? null : { operationId, template: path }
		},
		rateLimiter: limiter,
		redactor: new Redactor(),
	})
	const sent = () => wire.sent.filter((one) => one.url.endsWith("/rows/1")).map((one) => bearerOf(one.headers))
	return { client, fenced, limiter, sent }
}

/* Holds every untagged write for `ms`, as another write's 429 does. */
const hold = (limiter: RateLimiter, ms: number) => limiter.noteBackoff({ method: "DELETE", pathname: "/rows/2" }, ms)

describe("a request held past its credential's lifetime", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("leaves with the renewed token, and the token it resolved before the hold is never sent", async () => {
		vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "Date", "performance"] })
		const held = heldClient(() => json({}, 200))
		hold(held.limiter, HOLD_MS)
		const deleted = held.client.request("DELETE", "/rows/1", { as: { principal: "alpha" } })
		await vi.advanceTimersByTimeAsync(HOLD_MS + 1_000)
		expect((await deleted).status).toBe(200)
		expect(held.sent()).toEqual(["Bearer token-2"])
		expect(held.fenced.at(-1)).toBe("Bearer token-2")
	})

	it("renews again when the resend after a 401 is held past the renewed token's lifetime", async () => {
		vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "Date", "performance"] })
		/* The first send is refused, as a token the server dropped would be, and a 429 elsewhere holds its resend. */
		const held = heldClient((index, limiter) => {
			if (index > 0) return json({}, 200)
			hold(limiter, HOLD_MS)
			return json({}, 401)
		})
		const deleted = held.client.request("DELETE", "/rows/1", { as: { principal: "alpha" } })
		await vi.advanceTimersByTimeAsync(HOLD_MS + 1_000)
		expect((await deleted).status).toBe(200)
		expect(held.sent()).toEqual(["Bearer token-1", "Bearer token-3"])
	})

	it("renews through the same client with one slot, without deadlocking on the slot it holds", async () => {
		vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "Date", "performance"] })
		const held = heldClient(() => json({}, 200), { maxInFlight: 1, refreshThrough: true })
		hold(held.limiter, HOLD_MS)
		const deleted = held.client.request("DELETE", "/rows/1", { as: { principal: "alpha" } })
		await vi.advanceTimersByTimeAsync(HOLD_MS + 1_000)
		expect((await deleted).status).toBe(200)
		expect(held.sent()).toEqual(["Bearer token-2"])
	})
})

describe("a held request meant to send exactly what it was handed", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it.each([
		["a probe, which expects the refusal", { as: { principal: "alpha" }, probe: true }, "Bearer token-1"],
		["a held value", { as: { principal: "alpha", scheme: "jwt", value: "revoked" } }, "Bearer revoked"],
		["a forged value", { as: { forged: { scheme: "jwt", value: "garbage" } } }, "Bearer garbage"],
	] as const)("sends %s as resolved, however long it was held", async (_, options, carried) => {
		vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "Date", "performance"] })
		const held = heldClient(() => json({}, 401))
		hold(held.limiter, HOLD_MS)
		const deleted = held.client.request("DELETE", "/rows/1", options)
		await vi.advanceTimersByTimeAsync(HOLD_MS + 1_000)
		expect((await deleted).status).toBe(401)
		expect(held.sent()).toEqual([carried])
	})
})

/* A jwt whose expiry the server never states, issued by a login and renewed by a refresh. */
const UNSTATED: SecurityConfig = {
	jwt: {
		login: { from: "$.token", steps: [{ operationId: "auth.login" }] },
		refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
	},
}

interface Judged {
	client: Client
	/** The tokens the server accepts on /items; every other route also asks `rows`. */
	valid: Set<string>
	/** Whether the server lets a valid token delete rows. */
	rows: { open: boolean }
	issued: () => number
	sent: (path: string) => string[]
}

/* alpha's client over the real store; the server accepts a token while it is in `valid`, and refuses every issue after `issues`. */
function judgedClient(issues = Number.POSITIVE_INFINITY): Judged {
	const model = buildModel(ROWS_DOC)
	const principals = { alpha: {} }
	const valid = new Set<string>()
	const rows = { open: true }
	let issued = 0
	const ports: CredentialPorts = {
		...issuing(),
		steps: {
			run: async () => {
				if (issued >= issues) throw new Error("auth.refresh answered 401")
				issued += 1
				return { answer: { body: { token: `token-${issued}` }, cookies: {}, headers: {}, status: 200 }, scope: {} }
			},
		},
	}
	const wire = transport((sent) => {
		const token = bearerOf(sent.headers).replace("Bearer ", "")
		const open = sent.url.endsWith("/items") || rows.open
		return json({}, valid.has(token) && open ? 200 : 401)
	})
	const store = createStore({ ports, principals, schemes: model.schemes, security: UNSTATED })
	const client = new Client({
		baseUrl: "http://api.test",
		credentials: createCredentialSource({ model, principals, security: UNSTATED, store }),
		network: { fetchImpl: wire.fetch },
		operationResolver: (method, path) => {
			const operationId = ROUTES[`${method} ${path}`]
			return operationId === undefined ? null : { operationId, template: path }
		},
		redactor: new Redactor(),
	})
	const sent = (path: string) =>
		wire.sent.filter((one) => one.url.endsWith(path)).map((one) => bearerOf(one.headers).replace("Bearer ", ""))
	return { client, issued: () => issued, rows, sent, valid }
}

const asAlpha = { as: { principal: "alpha" } } as const

/* token-1 is refused on its first read, so alpha's credential becomes token-2, a renewal, which /items accepts. */
async function acceptedRenewal(judged: Judged): Promise<void> {
	judged.valid.add("token-2")
	expect((await judged.client.get("/items", asAlpha)).status).toBe(200)
	expect(judged.sent("/items")).toEqual(["token-1", "token-2"])
}

describe("a renewed credential refused later", () => {
	it("renews once when it lapsed after it was accepted, and every refused request resends the next one", async () => {
		const judged = judgedClient()
		await acceptedRenewal(judged)
		/* The server drops token-2, as it does a token past an expiry it never stated. */
		judged.valid.clear()
		judged.valid.add("token-3")
		const answers = await Promise.all([
			judged.client.request("DELETE", "/rows/1", asAlpha),
			judged.client.request("DELETE", "/rows/2", asAlpha),
		])
		expect(answers.map((answer) => answer.status)).toEqual([200, 200])
		expect([judged.sent("/rows/1"), judged.sent("/rows/2"), judged.issued()]).toEqual([
			["token-2", "token-3"],
			["token-2", "token-3"],
			3,
		])
		expect((await judged.client.get("/items", asAlpha)).status).toBe(200)
	})

	it("still blocks the principal when a renewal is refused on its first use, and the control read too", async () => {
		const judged = judgedClient()
		judged.valid.add("token-1")
		expect((await judged.client.get("/items", asAlpha)).status).toBe(200)
		judged.valid.clear()
		expect((await judged.client.request("DELETE", "/rows/1", asAlpha)).status).toBe(401)
		expect([judged.sent("/rows/1"), judged.sent("/items"), judged.issued()]).toEqual([
			["token-1", "token-2"],
			["token-1", "token-2"],
			2,
		])
		await expect(judged.client.get("/items", asAlpha)).rejects.toBeInstanceOf(UnsatisfiedSecurity)
	})

	it("renews nothing for a route that refuses the principal while the control read accepts it", async () => {
		const judged = judgedClient()
		await acceptedRenewal(judged)
		judged.rows.open = false
		expect((await judged.client.request("DELETE", "/rows/1", asAlpha)).status).toBe(401)
		expect((await judged.client.request("DELETE", "/rows/2", asAlpha)).status).toBe(401)
		expect([judged.sent("/rows/1"), judged.sent("/rows/2"), judged.issued()]).toEqual([["token-2"], ["token-2"], 2])
	})

	it("blocks the principal, sending nothing more, when it lapsed after it was accepted and its renewal is refused", async () => {
		const judged = judgedClient(2)
		await acceptedRenewal(judged)
		judged.valid.clear()
		expect((await judged.client.request("DELETE", "/rows/1", asAlpha)).status).toBe(401)
		expect(judged.sent("/rows/1")).toEqual(["token-2"])
		await expect(judged.client.get("/items", asAlpha)).rejects.toBeInstanceOf(UnsatisfiedSecurity)
	})
})
