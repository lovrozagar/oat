import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../config/types/security.ts"
import { answerOf, BEARER, fakePorts, NOW } from "./__fixtures__/ports.ts"
import { harness, SCHEMES } from "./__fixtures__/store.ts"
import { type Credential, createStore, type Held } from "./store.ts"

const valueOf = (held: Held): string => (held as Credential).value

describe("createStore: keys and placement", () => {
	it("keys a credential by principal × scheme × scope set, in any order", async () => {
		const { mintCalls, recorded, store } = harness()
		const ab = await store.acquire({ principal: "ann", scheme: "key", scopes: ["b", "a"] })
		const ba = await store.acquire({ principal: "ann", scheme: "key", scopes: ["a", "b"] })
		const a = await store.acquire({ principal: "ann", scheme: "key", scopes: ["a"] })
		const bob = await store.acquire({ principal: "bob", scheme: "key", scopes: ["a"] })
		expect([ab, valueOf(ba), valueOf(a), valueOf(bob)]).toEqual([ba, "k1", "k2", "k3"])
		expect(mintCalls().map((call) => [call.body, call.as])).toEqual([
			[{ scopes: ["a", "b"] }, { principal: "ann", scheme: "jwt" }],
			[{ scopes: ["a"] }, { principal: "ann", scheme: "jwt" }],
			[{ scopes: ["a"] }, { principal: "bob", scheme: "jwt" }],
		])
		expect(recorded.runs).toHaveLength(0)
	})

	it("signs in once whatever scopes a login credential is asked for, since the server decides", async () => {
		const { recorded, store } = harness()
		const scoped = await store.acquire({ principal: "ann", scheme: "jwt", scopes: ["admin"] })
		expect([scoped, recorded.runs.length]).toEqual([await store.acquire({ principal: "ann", scheme: "jwt" }), 1])
	})

	it("places the value by the scheme and the recipe's format, with its secrets and expiry", async () => {
		const { store } = harness()
		const jwt = await store.acquire({ principal: "ann", scheme: "jwt" })
		const key = await store.acquire({ principal: "ann", scheme: "key", scopes: ["a"] })
		expect(jwt).toEqual({
			expiresAt: NOW + 60_000,
			secrets: { cookies: [], headers: ["Authorization"], query: [], values: ["ann-1"] },
			sends: { cookies: {}, headers: { Authorization: "Bearer ann-1" }, query: {} },
			value: "ann-1",
		})
		expect([(key as Credential).sends.headers, (key as Credential).scopes]).toEqual([
			{ Authorization: "ApiKey k1" },
			["a"],
		])
	})
})

describe("createStore: identity and reasons", () => {
	it("binds a login's claims into the principal's identity, beside its config data", async () => {
		const { store } = harness()
		expect(store.identityOf("ann")).toEqual({ email: "ann@x.io", tenant: "t1" })
		await store.acquire({ principal: "dee", scheme: "jwt" })
		expect([store.identityOf("dee"), store.identityOf("zed")]).toEqual([{ email: "dee@x.io", tenant: "o7" }, {}])
	})

	it("blocks what it cannot acquire, with the reason", async () => {
		const { store } = harness()
		expect(
			await Promise.all([
				store.acquire({ principal: "zed", scheme: "jwt" }),
				store.acquire({ principal: "ann", scheme: "nope" }),
				store.acquire({ principal: "ann", scheme: "basic" }),
				store.acquire({ principal: "ann", scheme: "digest" }),
			]),
		).toEqual([
			{ blocked: 'no principal "zed" in the config' },
			{ blocked: 'the document declares no "nope" scheme' },
			{ blocked: 'principal "ann" has no recipe for the "basic" scheme' },
			{
				blocked: 'static for ann/digest: oat cannot send the "digest" scheme: http digest',
			},
		])
	})
})

describe("createStore: clock and isolation", () => {
	it("reads the system clock unless given one, and finds no principal on the prototype", async () => {
		const { ports } = fakePorts()
		const store = createStore({
			ports,
			principals: { ann: {} },
			schemes: SCHEMES,
			security: { jwt: { expiresIn: 60, static: "s" } },
		})
		const before = Date.now()
		const held = (await store.acquire({ principal: "ann", scheme: "jwt" })) as Credential
		expect(held.expiresAt).toBeGreaterThanOrEqual(before + 60_000)
		expect(held.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000)
		expect(await store.acquire({ principal: "constructor", scheme: "jwt" })).toEqual({
			blocked: 'no principal "constructor" in the config',
		})
	})

	it("keeps a short-lived credential until half its lifetime is left", async () => {
		let calls = 0
		const { ports } = fakePorts({ hook: () => Promise.resolve(`totp-${++calls}`) })
		const clock = { now: NOW }
		const store = createStore({
			now: () => clock.now,
			ports,
			principals: { ann: {} },
			schemes: SCHEMES,
			security: { jwt: { expiresIn: 20, hook: true } },
		})
		const values = []
		for (const step of [0, 5_000, 6_000]) {
			clock.now += step
			values.push(valueOf(await store.acquire({ principal: "ann", scheme: "jwt" })))
		}
		expect([values, calls]).toEqual([["totp-1", "totp-1", "totp-2"], 2])
	})
	it("shares nothing between two stores", async () => {
		const first = harness()
		const second = harness()
		await first.store.acquire({ principal: "ann", scheme: "jwt" })
		await second.store.acquire({ principal: "ann", scheme: "jwt" })
		expect([first.recorded.runs.length, second.recorded.runs.length]).toEqual([1, 1])
	})
})

describe("createStore: login", () => {
	it("shares one login between concurrent first acquires", async () => {
		const { recorded, store } = harness()
		const held = await Promise.all(Array.from({ length: 10 }, () => store.acquire({ principal: "ann", scheme: "jwt" })))
		expect([new Set(held.map(valueOf)), recorded.runs.length]).toEqual([new Set(["ann-1"]), 1])
	})

	it("attempts a login once: a failure is BLOCKED with the reason and never retried", async () => {
		const { recorded, store } = harness({ login: new Set(["ann"]) })
		const blocked = { blocked: "login for ann/jwt: auth step 1 answered 401" }
		const first = await Promise.all(Array.from({ length: 3 }, () => store.acquire({ principal: "ann", scheme: "jwt" })))
		const later = await store.acquire({ principal: "ann", scheme: "jwt", scopes: ["a"] })
		const refreshed = await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-1" })
		expect([...first, later, refreshed]).toEqual(Array.from({ length: 5 }, () => blocked))
		expect(recorded.runs).toHaveLength(1)
	})

	it("blocks a mint whose `with` credential is blocked, with the caller's reason", async () => {
		const { store } = harness({ login: new Set(["ann"]) })
		expect(await store.acquire({ principal: "ann", scheme: "key", scopes: ["a"] })).toEqual({
			blocked: 'mint for ann/key: "ann" is BLOCKED for jwt',
		})
	})
})

describe("createStore: refresh", () => {
	it("renews a stale credential once for 10 parallel callers", async () => {
		const { clock, recorded, store } = harness()
		await store.acquire({ principal: "ann", scheme: "jwt" })
		clock.now += 30_000
		const held = await Promise.all(Array.from({ length: 10 }, () => store.acquire({ principal: "ann", scheme: "jwt" })))
		expect([new Set(held.map(valueOf)), recorded.runs.map((run) => run.steps[0])]).toEqual([
			new Set(["ann-2"]),
			[{ body: { email: "ann@x.io" }, operationId: "auth.login" }, { operationId: "auth.refresh" }],
		])
	})

	it("renews once for 10 parallel callers refused with the same value", async () => {
		const { recorded, store } = harness()
		await store.acquire({ principal: "ann", scheme: "jwt" })
		const held = await Promise.all(
			Array.from({ length: 10 }, () => store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-1" })),
		)
		expect([new Set(held.map(valueOf)), recorded.runs.length]).toEqual([new Set(["ann-2"]), 2])
	})

	it("returns the newer credential to a caller that sent one already replaced", async () => {
		const { recorded, store } = harness()
		await store.acquire({ principal: "ann", scheme: "jwt" })
		const first = await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-1" })
		const second = await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-1" })
		expect([valueOf(first), valueOf(second), recorded.runs.length]).toEqual(["ann-2", "ann-2", 2])
		const third = await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-2" })
		expect([valueOf(third), recorded.runs.length]).toEqual(["ann-3", 3])
	})
})

describe("createStore: refresh outcomes", () => {
	it("acquires when nothing is held yet", async () => {
		const { recorded, store } = harness()
		const held = await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "elsewhere" })
		expect([valueOf(held), recorded.runs.length]).toEqual(["ann-1", 1])
	})

	it("signs in once more when the declared refresh fails, and renews from that session", async () => {
		const { recorded, store } = harness({ refresh: new Set(["ann"]) })
		await store.acquire({ principal: "ann", scheme: "jwt" })
		expect(valueOf(await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-1" }))).toBe("ann-2")
		expect(valueOf(await store.acquire({ principal: "ann", scheme: "jwt", scopes: ["other"] }))).toBe("ann-2")
		expect(recorded.runs.map((run) => "operationId" in run.steps[0]! && run.steps[0].operationId)).toEqual([
			"auth.login",
			"auth.refresh",
			"auth.login",
		])
	})

	it("blocks that principal × scheme when the login after a failed refresh fails too, while others carry on", async () => {
		const login = new Set<string>()
		const { recorded, store } = harness({ login, refresh: new Set(["ann"]) })
		await store.acquire({ principal: "ann", scheme: "jwt" })
		login.add("ann")
		/* The reason names the renewal and both refusals, never reading like a first sign-in that failed. */
		const blocked = {
			blocked:
				"renewal for ann/jwt: the refresh failed (refresh token reused), then acquiring afresh failed (auth step 1 answered 401)",
		}
		expect(await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-1" })).toEqual(blocked)
		expect(await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "ann-1" })).toEqual(blocked)
		expect(await store.acquire({ principal: "ann", scheme: "jwt", scopes: ["other"] })).toEqual(blocked)
		expect(recorded.runs).toHaveLength(3)
		expect(valueOf(await store.acquire({ principal: "cy", scheme: "jwt" }))).toBe("cy-2")
	})

	it("re-mints a credential with no refresh of its own, and blocks every scope set when that fails", async () => {
		const { mintCalls, store } = harness({ mint: (count) => count === 3 })
		await store.acquire({ principal: "ann", scheme: "key", scopes: ["a"] })
		const renewed = await store.refresh({ principal: "ann", scheme: "key", scopes: ["a"], sentValue: "k1" })
		const failed = await store.refresh({ principal: "ann", scheme: "key", scopes: ["a"], sentValue: "k2" })
		const other = await store.acquire({ principal: "ann", scheme: "key", scopes: ["b"] })
		const reason = "refresh for ann/key: mint apiKey.create answered 500"
		expect([valueOf(renewed), failed, other, mintCalls().length]).toEqual([
			"k2",
			{ blocked: reason },
			{ blocked: reason },
			3,
		])
	})
})

const SIGNUP = { method: "POST", operationId: "auth.register", path: "/v1/auth/register" }

/* A store whose jwt login is `steps` with no refresh, issuing `t<n>` per login run, given the run's signup. */
function signingUp(steps: SecurityConfig[string] & object, signup: typeof SIGNUP | null = SIGNUP) {
	let runs = 0
	const { ports, recorded } = fakePorts({
		run: () => Promise.resolve({ answer: answerOf({ t: `t${++runs}` }), scope: {} }),
	})
	const security: SecurityConfig = { jwt: steps }
	const store = createStore({
		ports,
		principals: { ann: {} },
		schemes: SCHEMES,
		security,
		...(signup === null ? {} : { signup }),
	})
	return { recorded, store }
}

describe("createStore: a login that signs up", () => {
	it("renews to BLOCKED instead of signing up again, by operationId or by a raw step to its route", async () => {
		const blocked = { blocked: "renewing ann/jwt would sign up again; declare a refresh" }
		for (const step of [{ operationId: "auth.register" }, { method: "post", path: "/v1/auth/register" }]) {
			const { recorded, store } = signingUp({ login: { from: "$.t", steps: [{ operationId: "auth.csrf" }, step] } })
			await store.acquire({ principal: "ann", scheme: "jwt" })
			expect(await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "t1" })).toEqual(blocked)
			expect(await store.acquire({ principal: "ann", scheme: "jwt" })).toEqual(blocked)
			expect(recorded.runs).toHaveLength(1)
		}
	})

	it("blocks a failed refresh of a login that signs up, never signing up again", async () => {
		const { ports, recorded } = fakePorts({
			run: (call) =>
				"operationId" in call.steps[0]! && call.steps[0].operationId === "auth.refresh"
					? Promise.reject(new Error("refresh token revoked"))
					: Promise.resolve({ answer: answerOf({ t: "t1" }), scope: {} }),
		})
		const security: SecurityConfig = {
			jwt: {
				login: { from: "$.t", steps: [{ operationId: "auth.register" }] },
				refresh: { from: "$.t", steps: [{ operationId: "auth.refresh" }] },
			},
		}
		const store = createStore({ ports, principals: { ann: {} }, schemes: SCHEMES, security, signup: SIGNUP })
		await store.acquire({ principal: "ann", scheme: "jwt" })
		expect(await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "t1" })).toEqual({
			blocked: "refresh for ann/jwt: refresh token revoked",
		})
		expect(recorded.runs).toHaveLength(2)
	})

	it("re-runs a login that calls no signup, or one on another origin, or when the document marks none", async () => {
		const otherRoute = { method: "POST", path: "/v1/auth/login" }
		const otherOrigin = { method: "POST", origin: "idp", path: "/v1/auth/register" }
		const cases = [
			signingUp({ login: { from: "$.t", steps: [{ operationId: "auth.login" }] } }),
			signingUp({ login: { from: "$.t", steps: [otherRoute] } }),
			signingUp({ login: { from: "$.t", steps: [otherOrigin] } }),
			signingUp({ login: { from: "$.t", steps: [{ operationId: "auth.register", origin: "idp" }] } }),
			signingUp({ login: { from: "$.t", steps: [{ operationId: "auth.register" }] } }, null),
			signingUp({ static: "s" }),
		]
		for (const { store } of cases) {
			const first = valueOf(await store.acquire({ principal: "ann", scheme: "jwt" }))
			const renewed = await store.refresh({ principal: "ann", scheme: "jwt", sentValue: first })
			expect(renewed).not.toHaveProperty("blocked")
		}
	})
})

describe("createStore: revokeAll", () => {
	it("revokes every credential it minted and returns the failures instead of throwing", async () => {
		const { recorded, store } = harness({ revoke: (scope) => (scope?.credential === "k2" ? 500 : 204) })
		await store.acquire({ principal: "ann", scheme: "key", scopes: ["a"] })
		await store.refresh({ principal: "ann", scheme: "key", scopes: ["a"], sentValue: "k1" })
		await store.acquire({ principal: "bob", scheme: "key", scopes: ["a"] })
		expect(await store.revokeAll()).toEqual([
			{ principal: "ann", reason: "revoke apiKey.revoke answered 500", scheme: "key" },
		])
		const revoked = recorded.calls.filter((call) => call.operationId === "apiKey.revoke")
		expect(revoked.map((call) => call.scope?.credential)).toEqual(["k1", "k2", "k3"])
		expect([await store.revokeAll(), recorded.calls.length]).toEqual([[], 6])
	})
})

describe("createStore: what blocked a credential", () => {
	it("names the step that failed, for whom and which scheme: here a recipe that names no kind", async () => {
		const odd = createStore({
			ports: fakePorts().ports,
			principals: { odd: { security: { odd: { format: "X {credential}" } } } },
			schemes: new Map([["odd", BEARER]]),
			security: {},
		})
		expect(await odd.acquire({ principal: "odd", scheme: "odd" })).toEqual({
			blocked: "acquire for odd/odd: the jwt recipe names no kind (login, mint, static, hook or oauth2)",
		})
	})
})

describe("createStore: adopt", () => {
	it("holds an adopted value as the principal's credential, placed like any other, with its recipe's lifetime", async () => {
		const { recorded, store } = harness()
		const adopted = await store.adopt({ principal: "ann", scheme: "jwt", value: "issued-1" })
		expect(adopted).toEqual({
			expiresAt: NOW + 60_000,
			secrets: { cookies: [], headers: ["Authorization"], query: [], values: ["issued-1"] },
			sends: { cookies: {}, headers: { Authorization: "Bearer issued-1" }, query: {} },
			value: "issued-1",
		})
		expect([await store.acquire({ principal: "ann", scheme: "jwt" }), recorded.runs.length]).toEqual([adopted, 0])
	})

	it("renews an adopted login credential by the recipe's declared refresh, from the scope it was adopted with", async () => {
		const { recorded, store } = harness()
		await store.adopt({ principal: "ann", scheme: "jwt", scope: { refresh_token: "r1" }, value: "issued-1" })
		const renewed = await store.refresh({ principal: "ann", scheme: "jwt", sentValue: "issued-1" })
		expect([valueOf(renewed), recorded.runs.map((run) => [run.steps[0], run.scope])]).toEqual([
			"ann-1",
			[[{ operationId: "auth.refresh" }, { credential: "issued-1", refresh_token: "r1" }]],
		])
	})

	it("replaces what was held, a blocked login or a blocked refresh alike", async () => {
		const { store } = harness({ login: new Set(["ann"]), refresh: new Set(["cy"]) })
		await store.acquire({ principal: "ann", scheme: "jwt" })
		await store.acquire({ principal: "cy", scheme: "jwt" })
		await store.refresh({ principal: "cy", scheme: "jwt", sentValue: "cy-1" })
		await store.adopt({ principal: "ann", scheme: "jwt", value: "invited" })
		await store.adopt({ principal: "cy", scheme: "jwt", value: "again" })
		const held = [
			await store.acquire({ principal: "ann", scheme: "jwt" }),
			await store.acquire({ principal: "cy", scheme: "jwt" }),
		]
		expect(held.map(valueOf)).toEqual(["invited", "again"])
	})

	it("refuses an empty value and keeps what it holds", async () => {
		const { store } = harness()
		const held = await store.adopt({ principal: "ann", scheme: "jwt", value: "issued-1" })
		expect(await store.adopt({ principal: "ann", scheme: "jwt", value: "" })).toEqual({
			blocked: "adopt for ann/jwt: an empty value is no credential",
		})
		expect(await store.acquire({ principal: "ann", scheme: "jwt" })).toEqual(held)
	})

	it("refuses a value it cannot place, with the reason", async () => {
		const { store } = harness()
		expect(await store.adopt({ principal: "ann", scheme: "nope", value: "v" })).toEqual({
			blocked: 'the document declares no "nope" scheme',
		})
		expect(await store.adopt({ principal: "ann", scheme: "digest", value: "v" })).toMatchObject({
			blocked: expect.stringMatching(/^adopt for ann\/digest: /),
		})
	})
})

describe("createStore: enroll and snapshot", () => {
	it("enrolls a principal of the run's own, which acquires by the shared recipes from its identity", async () => {
		const { recorded, store } = harness()
		store.enroll("disposable-1", { email: "d@x.io" })
		expect(store.principals["disposable-1"]).toEqual({ email: "d@x.io" })
		expect(valueOf(await store.acquire({ principal: "disposable-1", scheme: "jwt" }))).toBe("disposable-1-1")
		expect(recorded.runs[0]?.steps).toEqual([{ body: { email: "d@x.io" }, operationId: "auth.login" }])
		expect(store.identityOf("disposable-1")).toEqual({ email: "d@x.io" })
	})

	it("lists every credential it holds, by principal, scheme and scope set, and none that is blocked", async () => {
		const { store } = harness({ login: new Set(["cy"]) })
		const jwt = await store.acquire({ principal: "ann", scheme: "jwt" })
		const key = await store.acquire({ principal: "ann", scheme: "key", scopes: ["b", "a"] })
		await store.acquire({ principal: "cy", scheme: "jwt" })
		expect(await store.snapshot()).toEqual([
			{ credential: jwt, principal: "ann", scheme: "jwt", scopes: [] },
			{ credential: key, principal: "ann", scheme: "key", scopes: ["a", "b"] },
		])
	})
})

describe("createStore: a dedicated credential", () => {
	it("is acquired through the store, under a probe principal", async () => {
		const { store } = harness()
		expect(await store.acquireDedicated({ principal: "ann", scheme: "jwt" })).toMatchObject({
			principal: "ann#probe-1",
		})
	})
})

describe("createStore: a principal's own session", () => {
	it("is never revoked by its login's declared revoke: only a dedicated session is", async () => {
		const { recorded, store } = harness()
		await store.acquire({ principal: "ann", scheme: "jwt" })
		expect(await store.revokeAll()).toEqual([])
		expect(recorded.calls).toEqual([])
	})
})

describe("createStore: revoking principals' own sessions at the very end", () => {
	it("revokes each principal's login session once by its declared revoke, never a dedicated or other credential", async () => {
		const { recorded, store } = harness()
		const ann = await store.acquire({ principal: "ann", scheme: "jwt" })
		await store.acquire({ principal: "ann", scheme: "key", scopes: ["a"] })
		await store.acquire({ principal: "bob", scheme: "jwt" })
		await store.acquireDedicated({ principal: "cy", scheme: "jwt" })
		expect(await store.revokeSessions(() => true)).toEqual([])
		const logouts = recorded.calls.filter((call) => call.operationId === "auth.logout")
		expect(logouts.map((call) => [call.as, call.value])).toEqual([
			[{ principal: "ann", scheme: "jwt" }, (ann as Credential).value],
		])
	})

	it("leaves a principal the predicate excludes, and names a failure by principal and scheme", async () => {
		const { recorded, store } = harness({ logout: () => 500 })
		await store.acquire({ principal: "ann", scheme: "jwt" })
		await store.acquire({ principal: "cy", scheme: "jwt" })
		expect(await store.revokeSessions((principal) => principal !== "cy")).toEqual([
			{ principal: "ann", reason: "revoke auth.logout answered 500", scheme: "jwt" },
		])
		expect(recorded.calls.filter((call) => call.operationId === "auth.logout")).toHaveLength(1)
	})

	it("sends nothing for a login that declares no revoke, or one that failed", async () => {
		const { recorded, store } = harness({ login: new Set(["cy"]) })
		await store.acquire({ principal: "dee", scheme: "jwt" })
		await store.acquire({ principal: "cy", scheme: "jwt" })
		expect(await store.revokeSessions(() => true)).toEqual([])
		expect(recorded.calls).toEqual([])
	})
})
