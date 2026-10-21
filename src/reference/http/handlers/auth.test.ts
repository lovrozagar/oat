import { describe, expect, it } from "vitest"
import { api, BETA } from "../__fixtures__/api.ts"
import { createApiKey } from "../auth/api-keys.ts"
import type { ReferenceOptions } from "../state.ts"

const T0 = 1_800_000_000_000
const ALPHA_LOGIN = { email: "alpha@reference.test", password: "alpha-password" }

/* A call that sends `authorization` exactly as given. */
const as = (authorization: string) => ({ headers: { authorization }, token: null })

/* A reference on a clock a test moves. */
async function world(options: ReferenceOptions = {}) {
	const now = { ms: T0 }
	const reference = await api({ clock: () => now.ms, ...options })
	return { ...reference, now }
}

describe("auth.token", () => {
	it("trades a known key for a JWT pair that authenticates as its principal", async () => {
		const { call } = await world()
		const { status, body } = await call("POST", "/v1/auth/token", { body: { key: "key_beta" }, token: null })
		expect(status).toBe(200)
		expect(body).toMatchObject({ expires_in: 3600, project_id: "proj_beta" })
		expect(String(body.access_token).split(".")).toHaveLength(3)
		expect(String(body.refresh_token).split(".")).toHaveLength(3)
		expect((await call("GET", "/v1/projects/proj_beta/tables", as(`Bearer ${String(body.access_token)}`))).status).toBe(
			200,
		)
		expect(
			(await call("GET", "/v1/projects/proj_alpha/tables", as(`Bearer ${String(body.access_token)}`))).status,
		).toBe(403)
	})

	it("refuses an unknown or missing key with a 401, spells the expiry as a string under TOKEN_EXPIRY_AS_STRING", async () => {
		const { call } = await world({ defects: ["TOKEN_EXPIRY_AS_STRING"] })
		expect((await call("POST", "/v1/auth/token", { body: { key: "nope" } })).status).toBe(401)
		expect((await call("POST", "/v1/auth/token", { body: {} })).status).toBe(401)
		expect((await call("POST", "/v1/auth/token", { body: { key: "key_alpha" } })).body.expires_in).toBe("3600")
		expect((await call("GET", "/v1/auth/token")).status).toBe(404)
	})

	it("throttles a key after 5 failures within a minute under throttleLogins, the right key included", async () => {
		const { call, now } = await world({ throttleLogins: true })
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect((await call("POST", "/v1/auth/token", { body: { key: "key_ghost" }, token: null })).status).toBe(401)
		}
		const refused = await call("POST", "/v1/auth/token", { body: { key: "key_ghost" }, token: null })
		expect(refused.status).toBe(429)
		expect(refused.headers["retry-after"]).toBe("60")
		expect((await call("POST", "/v1/auth/token", { body: { key: "key_alpha" }, token: null })).status).toBe(200)
		now.ms += 60_000
		expect((await call("POST", "/v1/auth/token", { body: { key: "key_ghost" }, token: null })).status).toBe(401)
	})
})

describe("auth.login", () => {
	it("signs in by email and password, and refuses a wrong password with a 401", async () => {
		const { call } = await world()
		const { status, body } = await call("POST", "/v1/auth/login", { body: ALPHA_LOGIN, token: null })
		expect(status).toBe(200)
		expect(body).toMatchObject({ expires_in: 3600, project_id: "proj_alpha" })
		const wrong = { ...ALPHA_LOGIN, password: "nope" }
		expect((await call("POST", "/v1/auth/login", { body: wrong, token: null })).status).toBe(401)
		expect((await call("POST", "/v1/auth/login", { body: { email: "x" }, token: null })).status).toBe(400)
		expect((await call("POST", "/v1/auth/login", { form: "email=x", token: null })).status).toBe(415)
	})

	it("throttles an email after 5 failures under throttleLogins, but never under LOGIN_NOT_THROTTLED", async () => {
		for (const defects of [[], ["LOGIN_NOT_THROTTLED"]]) {
			const { call } = await world({ defects, throttleLogins: true })
			const wrong = { body: { ...ALPHA_LOGIN, password: "nope" }, token: null }
			for (let attempt = 0; attempt < 5; attempt += 1) await call("POST", "/v1/auth/login", wrong)
			const sixth = await call("POST", "/v1/auth/login", { body: ALPHA_LOGIN, token: null })
			expect(sixth.status).toBe(defects.length === 0 ? 429 : 200)
		}
	})

	it("demands a credential under PUBLIC_ROUTE_GUARDED, and signs in a caller that has one", async () => {
		const { call } = await world({ defects: ["PUBLIC_ROUTE_GUARDED"] })
		expect((await call("POST", "/v1/auth/login", { body: ALPHA_LOGIN, token: null })).status).toBe(401)
		expect((await call("POST", "/v1/auth/login", { body: ALPHA_LOGIN })).status).toBe(200)
	})
})

describe("auth.refresh", () => {
	it("rotates the pair, and a reused refresh token is a 401 that revokes the session", async () => {
		const { call } = await world()
		const first = (await call("POST", "/v1/auth/login", { body: ALPHA_LOGIN, token: null })).body
		const refresh = (token: unknown) =>
			call("POST", "/v1/auth/refresh", { body: { refresh_token: token }, token: null })
		const second = await refresh(first.refresh_token)
		expect(second.status).toBe(200)
		expect(second.body.refresh_token).not.toBe(first.refresh_token)
		expect((await refresh(first.refresh_token)).status).toBe(401)
		expect((await call("GET", "/v1/me", as(`Bearer ${String(second.body.access_token)}`))).status).toBe(401)
		expect((await refresh(42)).status).toBe(400)
	})
})

describe("auth.revoke", () => {
	it("revokes one of the caller's tokens, and takes only a bearer JWT", async () => {
		const { call, state } = await world()
		const session = (await call("POST", "/v1/auth/token", { body: { key: "key_alpha" }, token: null })).body
		const revoke = await call("POST", "/v1/auth/revoke", { body: { token: session.access_token } })
		expect(revoke).toMatchObject({ body: { revoked: true }, status: 200 })
		expect((await call("GET", "/v1/me", as(`Bearer ${String(session.access_token)}`))).status).toBe(401)
		expect((await call("POST", "/v1/auth/revoke", { body: { token: "x" }, token: null })).status).toBe(401)
		const key = createApiKey(state, state.auth.accounts.get("key_alpha") as never, [])
		expect((await call("POST", "/v1/auth/revoke", { body: { token: "x" }, ...as(`ApiKey ${key.value}`) })).status).toBe(
			401,
		)
	})
})

describe("auth.logout", () => {
	it("revokes only the caller's access token, and needs one", async () => {
		const { call } = await world()
		const session = (await call("POST", "/v1/auth/token", { body: { key: "key_alpha" }, token: null })).body
		const caller = as(`Bearer ${String(session.access_token)}`)
		expect((await call("POST", "/v1/logout", caller)).body).toEqual({ ok: true })
		expect((await call("GET", "/v1/me", caller)).status).toBe(401)
		expect((await call("GET", "/v1/me")).status).toBe(200)
		expect((await call("POST", "/v1/logout", { token: null })).status).toBe(401)
	})

	it("signs every account out under DISPOSABLE_KILLS_CALLER, and an API key's logout revokes nothing", async () => {
		const { call } = await world({ defects: ["DISPOSABLE_KILLS_CALLER"] })
		const registered = await call("POST", "/v1/register", { body: { email: "d@x.test" }, token: null })
		const disposable = String(registered.body.access_token)
		await call("POST", "/v1/logout", { token: disposable })
		expect((await call("GET", "/v1/me")).status).toBe(401)
		const again = (await call("POST", "/v1/auth/token", { body: { key: "key_alpha" }, token: null })).body
		expect((await call("GET", "/v1/me", { token: String(again.access_token) })).status).toBe(401)
		const open = await world({ defects: ["ANY_SCHEME_ACCEPTED"] })
		const key = createApiKey(open.state, open.state.auth.accounts.get("key_alpha") as never, [])
		expect((await open.call("POST", "/v1/logout", as(`ApiKey ${key.value}`))).status).toBe(200)
		expect((await open.call("GET", "/v1/me", as(`ApiKey ${key.value}`))).status).toBe(200)
	})
})

describe("auth.register", () => {
	it("registers a fresh admin of the first tenant and answers its access token", async () => {
		const { call } = await world()
		const { status, body } = await call("POST", "/v1/register", { body: { email: "new@x.test" }, token: null })
		expect(status).toBe(201)
		expect(Object.keys(body)).toEqual(["access_token"])
		const token = String(body.access_token)
		expect((await call("GET", "/v1/me", { token })).status).toBe(200)
		expect((await call("GET", "/v1/projects/proj_alpha/tables", { token })).status).toBe(200)
		expect((await call("GET", "/v1/me", { token: BETA })).status).toBe(200)
	})

	it("refuses a body it cannot read, or one without an email, with a 400, and adds no account", async () => {
		const { call, state } = await world()
		const accounts = state.auth.accounts.size
		for (const body of ["{", {}, { email: 5 }, { email: "a@x.test", role: "admin" }]) {
			expect((await call("POST", "/v1/register", { body, token: null })).status).toBe(400)
		}
		expect(state.auth.accounts.size).toBe(accounts)
	})
})
