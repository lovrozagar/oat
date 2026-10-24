import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { SecurityConfig } from "../../config/types/security.ts"
import type { Credential } from "../../credentials/store.ts"
import type { RunOptions } from "./types.ts"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import { connected, fetchOf, optionsFor, overriding, withLogin } from "./__fixtures__/api.ts"
import { keysApi, MINTED } from "./__fixtures__/keys.ts"

/*
 * A token endpoint that answers its pair as a form, `application/x-www-form-urlencoded` with a
 * charset, as some do: a login and an OAuth 2 grant read it by its media type, and renew by the
 * refresh token it carried. The same text under any other type stays unread, and says so.
 */

const FORM = "application/x-www-form-urlencoded; charset=utf-8"

/** `options`, with every 200 answer to `path` sent again as its fields' form text, under `type`. */
function retyped<T extends RunOptions>(options: T, at: { path: string; type: string }): T {
	const serve = fetchOf(options)
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const response = await serve(input, init)
		if (new URL(String(input)).pathname !== at.path || response.status !== 200) return response
		const fields = Object.entries((await response.json()) as Record<string, unknown>)
		const text = new URLSearchParams(
			Object.fromEntries(fields.map(([name, value]) => [name, String(value)])),
		).toString()
		return new Response(text, { headers: { "content-type": at.type }, status: 200 })
	}
	return { ...options, network: { ...options.network, fetch } }
}

/** An access and a refresh token, numbered by each issue, and an hour's lifetime. */
function issuing(path: string): Responder {
	let issued = 0
	return (_method, at) => {
		if (at !== path) return undefined
		issued += 1
		const pair = { access_token: `acc-${issued}-9f8e7d`, refresh_token: `ref-${issued}-1a2b3c` }
		return { body: { ...pair, expires_in: 3600 }, status: 200 }
	}
}

/** A login that saves the refresh token it answered, and a refresh that sends it back. */
const FORM_LOGIN: SecurityConfig = {
	bearer: {
		expiresIn: { from: "expires_in" },
		login: { from: "access_token", steps: [{ operationId: "auth.login", saveAs: { refresh_token: "refresh_token" } }] },
		refresh: {
			from: "access_token",
			steps: [{ body: { refresh_token: "{refresh_token}" }, operationId: "auth.login" }],
		},
	},
}

const loginAnswering = (type: string) =>
	retyped(optionsFor(overriding(withLogin(), issuing("/login")), { security: FORM_LOGIN }), { path: "/login", type })

const grantAnswering = (type: string) =>
	retyped(
		optionsFor(overriding(keysApi(), issuing("/token")), {
			principals: { alpha: { scope: { project_id: "p1" } } },
			security: MINTED,
		}),
		{ path: "/token", type },
	)

const ALPHA = { principal: "alpha", scheme: "bearer" }
const OAUTH = { principal: "alpha", scheme: "oauth" }

describe("runStore: a token answered as a form", () => {
	it("signs a login in from a form answer, renews by its refresh token, and holds both as secrets", async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ["Date"] })
		onTestFinished(() => {
			vi.useRealTimers()
		})
		const options = loginAnswering(FORM)
		const ctx = await connected(options)
		const held = await ctx.store.acquire(ALPHA)
		expect(held).not.toHaveProperty("blocked")
		const { expiresAt, value } = held as Credential
		expect(value).toBe("acc-1-9f8e7d")
		expect(expiresAt).toBe(Date.UTC(2026, 0, 1) + 3_600_000)
		const renewed = await ctx.store.refresh({ ...ALPHA, sentValue: value })
		expect((renewed as Credential).value).toBe("acc-2-9f8e7d")
		const logins = options.seen.filter((request) => request.path === "/login")
		expect(logins[1]?.body).toEqual({ refresh_token: "ref-1-1a2b3c" })
		const { redactor } = ctx.client
		expect(["acc-1-9f8e7d", "ref-1-1a2b3c", "acc-2-9f8e7d"].map((token) => redactor.holdsSecret(token))).toEqual([
			true,
			true,
			true,
		])
	})

	it("takes an OAuth 2 client-credentials token from a form answer, and renews by its refresh token", async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ["Date"] })
		onTestFinished(() => {
			vi.useRealTimers()
		})
		const options = grantAnswering(FORM)
		const ctx = await connected(options)
		const held = await ctx.store.acquire(OAUTH)
		expect(held).not.toHaveProperty("blocked")
		const { expiresAt, value } = held as Credential
		expect([value, expiresAt]).toEqual(["acc-1-9f8e7d", Date.UTC(2026, 0, 1) + 3_600_000])
		await ctx.store.refresh({ ...OAUTH, sentValue: value })
		const grants = options.seen.filter((request) => request.path === "/token")
		const renewal = new URLSearchParams(String(grants[1]?.body))
		expect([renewal.get("grant_type"), renewal.get("refresh_token")]).toEqual(["refresh_token", "ref-1-1a2b3c"])
		expect(ctx.client.redactor.holdsSecret("ref-1-1a2b3c")).toBe(true)
	})

	it("reads no credential from the same text answered as text/plain, and names that type", async () => {
		const login = await connected(loginAnswering("text/plain"))
		expect(await login.store.acquire(ALPHA)).toMatchObject({
			blocked: expect.stringContaining(
				'saveAs.refresh_token = "refresh_token", which is not present in the response (its answer is text/plain)',
			),
		})
		const grant = await connected(grantAnswering("text/plain"))
		expect(await grant.store.acquire(OAUTH)).toMatchObject({
			blocked: expect.stringContaining(
				"oauth2 token request answered no credential at $.access_token (its answer is text/plain)",
			),
		})
	})
})
