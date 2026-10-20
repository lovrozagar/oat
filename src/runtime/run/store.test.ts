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
		expect([login?.headers.authorization, ctx.client.transcript[0]?.purpose]).toEqual([undefined, "auth"])
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
		expect([mint?.headers.authorization, mint?.body]).toEqual(["Bearer alpha-key", { label: "oat" }])
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
		expect(options.seen.filter((request) => request.method === "DELETE").map((r) => r.headers.authorization)).toEqual([
			"Bearer alpha-key",
			"Bearer alpha-key",
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
		expect([key.value, mint.map((request) => [request.path, request.headers.authorization])]).toEqual([
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
		expect([post?.headers.authorization, post?.headers["content-type"]]).toEqual([
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
			optionsFor(notesApi(), { sharedCredentials: { mapping: { bearer: "bearer" }, store: primary.store } }),
		)
		expect(origin.store).toBe(primary.store)
	})
})
