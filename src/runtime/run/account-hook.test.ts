import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SecurityConfig } from "../../config/types/security.ts"
import { contextOf, EMAIL_LOGIN, optionsFor, withSignup } from "./__fixtures__/api.ts"
import { teardownAccounts } from "./accounts.ts"

/*
 * A long run's teardown comes after the account's short-lived token has lapsed, so the hook is handed
 * a live one: the run renews it first, and hands the one it holds when renewing fails.
 */

type Login = (email: string, lapsed: boolean) => { body: Record<string, unknown>; status: number }

type Hook = (credential: string) => Promise<void>

/** Signs `fresh` up and in on a bearer that lapses in 300 s, uses it once, then tears down 600 s later. */
async function lapsedTeardown(login: Login, hook: Hook = async () => undefined) {
	let lapsed = false
	const answer = withSignup(() => ({ status: 201 }))
	const handed: string[] = []
	const stale: Array<string | undefined> = []
	const ctx = await contextOf(
		optionsFor(
			(method, path, request) =>
				path === "/login"
					? login(String((request.body as Record<string, unknown>)["email"]), lapsed)
					: answer(method, path, request),
			{
				hooks: {
					teardownPrincipal: async (_address, held) => {
						handed.push(held.credential)
						stale.push(held.stale)
						await hook(held.credential)
					},
				},
				principals: { alpha: { email: "alpha@x.test" }, fresh: { fresh: true } },
				security: { bearer: { ...EMAIL_LOGIN["bearer"], expiresIn: 300 } as SecurityConfig[string] },
			},
		),
	)
	await ctx.client.request("GET", "/notes", { as: { principal: "fresh" }, operationId: "notes.list" })
	lapsed = true
	vi.setSystemTime(Date.now() + 600_000)
	await teardownAccounts(ctx)
	const email = String(ctx.principals.byId.get("fresh")?.identity["email"])
	return { email, entry: ctx.accounts.entries()[0], failed: ctx.state.teardown?.failed ?? [], handed, stale }
}

describe("teardownAccounts, by the hook, once the account's credential has lapsed", () => {
	beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }))
	afterEach(() => vi.useRealTimers())

	it("hands the hook a renewed credential", async () => {
		const { email, entry, handed, stale } = await lapsedTeardown((who, lapsed) => ({
			body: { access_token: `${lapsed ? "renewed" : "held"}-${who}` },
			status: 200,
		}))
		expect(entry?.status).toBe("removed")
		expect(handed).toEqual([`renewed-${email}`])
		expect(stale).toEqual([undefined])
	})

	it("hands the hook the credential it holds, marked stale with why, when renewing it fails", async () => {
		const { email, failed, handed, stale } = await lapsedTeardown((who, lapsed) =>
			lapsed ? { body: {}, status: 500 } : { body: { access_token: `held-${who}` }, status: 200 },
		)
		expect(failed).toEqual([])
		expect(handed).toEqual([`held-${email}`])
		/* told the credential is stale, and why, so it can take another way in instead of sending it */
		expect(stale).toEqual([expect.stringMatching(/^refresh for fresh\/bearer: /)])
	})

	it("says renewing was blocked when the hook handed the credential it holds fails too", async () => {
		const { failed } = await lapsedTeardown(
			(who, lapsed) => (lapsed ? { body: {}, status: 500 } : { body: { access_token: `held-${who}` }, status: 200 }),
			async () => {
				throw new Error("answered 401")
			},
		)
		expect(failed[0]?.reason).toMatch(
			/^hooks\.teardownPrincipal threw: answered 401, handed the credential it holds because renewing it was blocked: \S/,
		)
	})
})
