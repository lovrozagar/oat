import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../config/types/security.ts"
import type { Credential } from "../../credentials/store.ts"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import {
	connected,
	LOGIN,
	notesApi,
	optionsFor,
	overriding,
	unreachable,
	withLogin,
	withSignup,
} from "./__fixtures__/api.ts"
import { keysApi, MINTED } from "./__fixtures__/keys.ts"
import { seenValue } from "../contract/params.ts"
import { buildModel } from "../../spec/graph/build.ts"
import { cloudflare } from "../../spec/security/__fixtures__/documents.ts"
import type { LoadedOrigin } from "./context.ts"
import { originSchemes } from "./store.ts"

/* The run's one store, and the ports it sends through: the step engine, the primary client, a token form. */

/** A credential hook that names the scheme and the principal it was asked for. */
const resolveCredential = async (scheme: string, principal: { id: string }) => `${scheme}-${principal.id}`

const keyed = (extra: Parameters<typeof optionsFor>[1] = {}) =>
	optionsFor(keysApi(), { principals: { alpha: { scope: { project_id: "p1" } } }, security: MINTED, ...extra })

/** Mints `k-delegate` for project p2, the invited delegate's own. */
const delegateKeys: Responder = (method, path) =>
	method === "POST" && path === "/projects/p2/keys" ? { body: { id: 9, key: "k-delegate" }, status: 201 } : undefined

describe("runStore: steps", () => {
	it("signs a login principal in through the step engine, as nobody", async () => {
		const options = optionsFor(withLogin(), { security: LOGIN })
		const ctx = await connected(options)
		expect(((await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })) as Credential).value).toBe("token-1")
		const login = options.seen.find((request) => request.path === "/login")
		expect([login?.headers["authorization"], ctx.client.transcript[0]?.purpose]).toEqual([undefined, "auth"])
	})

	it("leaves a refused login BLOCKED, with no outage noted", async () => {
		const ctx = await connected(optionsFor(withLogin({ failing: true, issued: 0 }), { security: LOGIN }))
		expect(await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })).toMatchObject({
			blocked: expect.stringMatching(/^login for alpha\/bearer: .*got 500/),
		})
		expect(ctx.network.outcome).toBeUndefined()
	})

	it("holds nothing for an API whose config names no recipe", async () => {
		const { security: _none, ...bare } = optionsFor(notesApi())
		const ctx = await connected(bare)
		expect(await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })).toEqual({
			blocked: 'principal "alpha" has no recipe for the "bearer" scheme',
		})
	})

	it("notes a login that never gets an answer as the run's outage before it is BLOCKED", async () => {
		const served = optionsFor(withLogin(), { security: LOGIN })
		const serve = served.network?.fetch as typeof fetch
		const fetch: typeof globalThis.fetch = (input, init) =>
			String(input).endsWith("/login") ? unreachable(input, init) : serve(input, init)
		const ctx = await connected({ ...served, network: { ...served.network, fetch } })
		expect(await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })).toMatchObject({
			blocked: expect.stringMatching(/^login for alpha\/bearer: /),
		})
		expect(ctx.network.outcome?.kind).toBe("refused")
	})

	it("fails a signup login with no refresh closed on renewal, never signing up again", async () => {
		let signups = 0
		const signup = () => ({ body: { access_token: `made-${++signups}` }, status: 201 })
		const body = { email: "a@x.test", password: "secret-pw", tenant: "t1" }
		const security: SecurityConfig = {
			bearer: { login: { from: "$.access_token", steps: [{ body, operationId: "auth.signup" }] } },
		}
		const ctx = await connected(optionsFor(withSignup(signup), { security }))
		await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })
		expect(await ctx.store.refresh({ principal: "alpha", scheme: "bearer", sentValue: "made-1" })).toEqual({
			blocked: "renewing alpha/bearer would sign up again; declare a refresh",
		})
		expect(signups).toBe(1)
	})
})

describe("runStore: operations", () => {
	it("mints through the primary client as the principal sending the `with` scheme, over its scope", async () => {
		const options = keyed()
		const ctx = await connected(options)
		const key = (await ctx.store.acquire({ principal: "alpha", scheme: "key" })) as Credential
		expect([key.value, key.sends.headers]).toEqual(["k1", { "x-api-key": "k1" }])
		const mint = options.seen.find((request) => request.path === "/projects/p1/keys")
		expect([mint?.headers["authorization"], mint?.body]).toEqual(["Bearer alpha-key", { label: "oat" }])
		expect(ctx.client.transcript.at(-1)).toMatchObject({ principal: "alpha", purpose: "auth", schemes: ["bearer"] })
	})

	it("re-mints a key the API turns away, and revokes the superseded key and the new one at the end", async () => {
		const options = keyed()
		const ctx = await connected(options)
		const answer = await ctx.client.request("GET", "/secure", { as: { principal: "alpha" } })
		/* Sent with the re-minted key, which the run's redactor scrubs wherever it is written down. */
		expect([answer.status, answer.requestHeaders["x-api-key"]]).toEqual([200, "k2"])
		expect(ctx.client.redactor.headers(answer.requestHeaders)["x-api-key"]).toBe("<redacted>")
		expect(await ctx.store.revokeAll()).toEqual([])
		const revoked = options.seen.filter((request) => request.method === "DELETE").map((request) => request.path)
		expect(revoked).toEqual(["/projects/p1/keys/1", "/projects/p1/keys/2"])
		expect(
			options.seen.filter((request) => request.method === "DELETE").map((r) => r.headers["authorization"]),
		).toEqual(["Bearer alpha-key", "Bearer alpha-key"])
	})

	it("revokes a minted key at its own path when the parameter there is named unlike any answer field", async () => {
		const options = optionsFor(keysApi(204, { keyParam: "api_key_id" }), {
			principals: { alpha: { scope: { project_id: "p1" } } },
			security: MINTED,
		})
		const ctx = await connected(options)
		await ctx.store.acquire({ principal: "alpha", scheme: "key" })
		expect(await ctx.store.revokeAll()).toEqual([])
		expect(options.seen.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([
			"/projects/p1/keys/1",
		])
	})

	it("sends as an invited delegate from the delegate's own scope, never the owner's, once it adopts a credential", async () => {
		const principals = { alpha: { scope: { project_id: "p1" } }, delegate: { scope: { project_id: "p2" } } }
		const options = optionsFor(overriding(keysApi(), delegateKeys), { principals, security: MINTED })
		const ctx = await connected(options)
		const scope = { project_id: "p1", refresh_token: "r1" }
		await ctx.store.adopt({ principal: "delegate", scheme: "bearer", scope, value: "invited-1" })
		const key = (await ctx.store.acquire({ principal: "delegate", scheme: "key" })) as Credential
		const mint = options.seen.filter((request) => request.method === "POST")
		expect([key.value, mint.map((request) => [request.path, request.headers["authorization"]])]).toEqual([
			"k-delegate",
			[["/projects/p2/keys", "Bearer invited-1"]],
		])
		expect(ctx.client.transcript.at(-1)).toMatchObject({ principal: "delegate", schemes: ["bearer"] })
	})
})

describe("runStore: tokens and hooks", () => {
	it("posts an OAuth 2 token form as nobody, to the URL the document declares", async () => {
		const options = keyed()
		const ctx = await connected(options)
		const granted = (await ctx.store.acquire({ principal: "alpha", scheme: "oauth" })) as Credential
		expect(granted.value).toBe("granted-1")
		const post = options.seen.find((request) => request.path === "/token")
		expect([post?.headers["authorization"], post?.headers["content-type"]]).toEqual([
			undefined,
			"application/x-www-form-urlencoded",
		])
		expect(new URLSearchParams(String(post?.body)).get("grant_type")).toBe("client_credentials")
	})

	it("asks hooks.resolveCredential for a hooked recipe", async () => {
		const ctx = await connected(
			optionsFor(notesApi(), { hooks: { resolveCredential }, security: { bearer: { hook: true } } }),
		)
		expect(((await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })) as Credential).value).toBe(
			"bearer-alpha",
		)
	})

	it("hands a secondary origin's run the primary's store", async () => {
		const primary = await connected(optionsFor(notesApi()))
		const origin = await connected(
			optionsFor(notesApi(), {
				sharedCredentials: { mapping: { bearer: "bearer" }, originOnly: new Set(), store: primary.store },
			}),
		)
		expect(origin.store).toBe(primary.store)
	})
})

describe("originSchemes", () => {
	it("pairs each declared origin's mapping with its loaded document's schemes, in config order", () => {
		const cf = { doc: cloudflare, model: buildModel(cloudflare) } as LoadedOrigin
		const origin = { baseUrl: "http://cf.test", id: "cf", security: { api_token: "cfToken" }, spec: "cf.json" }
		const loaded = { options: optionsFor(notesApi(), { origins: [origin] }), origins: new Map([["cf", cf]]) }
		expect(originSchemes(loaded)).toEqual([{ mapping: { api_token: "cfToken" }, schemes: cf.model.schemes }])
		expect(originSchemes({ options: optionsFor(notesApi()), origins: new Map() })).toEqual([])
	})
})

const journalOf = (dir: string): string =>
	readdirSync(join(dir, "exchanges"))
		.map((file) => readFileSync(join(dir, "exchanges", file), "utf8"))
		.join("\n")

/* Every exchange file `acquire` left in a fresh journal, as text. */
async function journaled(options: ReturnType<typeof optionsFor>, key: { principal: string; scheme: string }) {
	const dir = mkdtempSync(join(tmpdir(), "oat-run-store-"))
	try {
		const ctx = await connected({ ...options, exchangeDir: dir })
		expect(await ctx.store.acquire(key)).not.toHaveProperty("blocked")
		await ctx.journal?.flush()
		return journalOf(dir)
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

/* A login that answers its token under a neutral key no name rule would redact. */
const neutralLogin: Responder = (_method, path) =>
	path === "/login" ? { body: { jwt: "neutral-login-value" }, status: 200 } : undefined

/* A mint that answers a key under a neutral field. */
const neutralMint: Responder = (method, path) =>
	path === "/projects/p1/keys" && method === "POST"
		? { body: { id: 7, key: "ak_minted_secret_1" }, status: 201 }
		: undefined

describe("runStore: a recipe's extracted value is a secret before its answer is journaled", () => {
	it("scrubs a login's credential, under a key no name rule knows, from the journaled answer", async () => {
		const security: SecurityConfig = { bearer: { login: { from: "$.jwt", steps: [{ operationId: "auth.login" }] } } }
		const written = await journaled(optionsFor(overriding(withLogin(), neutralLogin), { security }), {
			principal: "alpha",
			scheme: "bearer",
		})
		expect(written).toContain('"operationId": "auth.login"')
		expect(written).not.toContain("neutral-login-value")
	})

	it("scrubs a minted key from the journaled mint answer", async () => {
		const options = optionsFor(overriding(keysApi(), neutralMint), {
			principals: { alpha: { scope: { project_id: "p1" } } },
			security: MINTED,
		})
		const written = await journaled(options, { principal: "alpha", scheme: "key" })
		expect(written).toContain('"operationId": "keys.create"')
		expect(written).not.toContain("ak_minted_secret_1")
	})
})

/* A login that answers, and a notes read that always refuses, so a 401 would tempt a renewal. */
const notesUnauthorized: Responder = (method, path) =>
	path === "/login"
		? { body: { jwt: "neutral-login-value" }, status: 200 }
		: method === "GET" && path === "/notes"
			? { status: 401 }
			: undefined

describe("runStore: a revoke sends its own session's value", () => {
	it("sends a revoke's own value as that principal's, never renewed, and counts its 401 as revoked", async () => {
		const security: SecurityConfig = {
			bearer: { login: { from: "$.jwt", revoke: "notes.list", steps: [{ operationId: "auth.login" }] } },
		}
		const options = optionsFor(overriding(withLogin(), notesUnauthorized), { security })
		const ctx = await connected(options)
		const probe = await ctx.store.acquireDedicated({ principal: "alpha", scheme: "bearer" })
		if ("blocked" in probe) throw new Error(probe.blocked)
		/* The revoke carried the very session it ends: a 401 says that session is already unusable. */
		await expect(probe.revoke?.()).resolves.toBeUndefined()
		const sent = options.seen.filter((request) => request.path === "/notes")
		expect(sent.map((request) => request.headers["authorization"])).toEqual(["Bearer neutral-login-value"])
		const revoke = ctx.client.transcript.at(-1)
		expect(revoke).toMatchObject({ operationId: "notes.list", principal: probe.principal, purpose: "auth" })
		expect(revoke).not.toHaveProperty("forged")
		expect(ctx.client.redactor.headers(revoke?.requestHeaders ?? {})).toEqual({
			Authorization: "Bearer <redacted>",
			"cache-control": "no-cache",
		})
	})
})

/* The keys API, where each key revoke answers the next of `statuses`, then 204. */
function revoking(...statuses: number[]): Responder {
	const keys = keysApi()
	return (method, path, request) =>
		method === "DELETE" && path.startsWith("/projects/p1/keys/")
			? { status: statuses.shift() ?? 204 }
			: keys(method, path, request)
}

describe("runStore: a mint revoke its caller is refused", () => {
	it("renews the caller once and sends the revoke again, which may then succeed", async () => {
		const options = optionsFor(revoking(401), {
			principals: { alpha: { scope: { project_id: "p1" } } },
			security: MINTED,
		})
		const ctx = await connected(options)
		await ctx.store.acquire({ principal: "alpha", scheme: "key" })
		expect(await ctx.store.revokeAll()).toEqual([])
		expect(options.seen.filter((request) => request.method === "DELETE")).toHaveLength(2)
	})

	it("reports the key unremovable when the renewed caller is refused again: the key may still be alive", async () => {
		const options = optionsFor(revoking(401, 401), {
			principals: { alpha: { scope: { project_id: "p1" } } },
			security: MINTED,
		})
		const ctx = await connected(options)
		await ctx.store.acquire({ principal: "alpha", scheme: "key" })
		expect(await ctx.store.revokeAll()).toEqual([
			{ principal: "alpha", reason: "revoke keys.revoke answered 401", scheme: "key" },
		])
		expect(options.seen.filter((request) => request.method === "DELETE")).toHaveLength(2)
	})
})

/* A login that answers `token-<n>`, and a refresh that runs it again, as a rotation would. */
const ROTATING: SecurityConfig = {
	bearer: {
		login: { from: "$.token", steps: [{ operationId: "auth.login" }] },
		refresh: { from: "$.token", steps: [{ operationId: "auth.login" }] },
	},
}

describe("runStore: its exchanges are real ones of documented operations", () => {
	it("labels a login and a token grant no probe, and a replayed refresh, meant to be refused, one", async () => {
		const ctx = await connected(optionsFor(withLogin(), { security: ROTATING }))
		const probe = await ctx.store.acquireDedicated({ principal: "alpha", scheme: "bearer" })
		if ("blocked" in probe) throw new Error(probe.blocked)
		const rotated = await (probe.rotate as NonNullable<typeof probe.rotate>)()
		await rotated.replay()
		expect(ctx.client.transcript.map((exchange) => [exchange.operationId, exchange.probe])).toEqual([
			["auth.login", undefined],
			["auth.login", undefined],
			["auth.login", true],
		])
		const keys = await connected(keyed())
		await keys.store.acquire({ principal: "alpha", scheme: "oauth" })
		expect(keys.client.transcript.at(-1)).not.toHaveProperty("probe")
	})

	it("labels a replayed OAuth 2 refresh grant a probe, and the grants before it none", async () => {
		const keys = keysApi()
		let granted = 0
		const rotating: Responder = (method, path, request) =>
			path === "/token"
				? { body: { access_token: `granted-${++granted}`, refresh_token: "r1" }, status: 200 }
				: keys(method, path, request)
		const ctx = await connected(
			optionsFor(rotating, { principals: { alpha: { scope: { project_id: "p1" } } }, security: MINTED }),
		)
		const probe = await ctx.store.acquireDedicated({ principal: "alpha", scheme: "oauth" })
		if ("blocked" in probe) throw new Error(probe.blocked)
		await (await (probe.rotate as NonNullable<typeof probe.rotate>)()).replay()
		expect(ctx.client.transcript.map((exchange) => exchange.probe)).toEqual([undefined, undefined, true])
	})

	it("redacts the token a login answered wherever an exchange quoting it is written down", async () => {
		const ctx = await connected(optionsFor(withLogin(), { security: LOGIN }))
		await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })
		const [login] = ctx.client.transcript
		expect(ctx.client.redactor.json(login?.responseBody)).toMatchObject({ token: "<redacted>" })
	})
})

/* A login that answers an access and a refresh token. */
const tokens: Responder = (_method, path) =>
	path === "/login" ? { body: { refresh_token: "ref-1a2b3c4d5e", token: "acc-9f8e7d6c5b" }, status: 200 } : undefined

describe("runStore: a login's tokens never feed a generated value", () => {
	it("leaves neither the access nor the refresh token a login answered to fill a parameter from seen values", async () => {
		const security: SecurityConfig = {
			bearer: {
				login: { from: "$.token", steps: [{ operationId: "auth.login", saveAs: { refresh: "$.refresh_token" } }] },
			},
		}
		const ctx = await connected(optionsFor(overriding(withLogin(), tokens), { security }))
		await ctx.store.acquire({ principal: "alpha", scheme: "bearer" })
		const { redactor, transcript } = ctx.client
		expect(transcript.map((exchange) => exchange.operationId)).toEqual(["auth.login"])
		expect(seenValue(transcript, "token", redactor)).toBeUndefined()
		expect(seenValue(transcript, "refresh_token", redactor)).toBeUndefined()
	})
})
