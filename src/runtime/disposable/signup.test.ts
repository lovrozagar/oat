import { describe, expect, it } from "vitest"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { accounts, accountsApi, accountsDoc, stageOf } from "./__fixtures__/accounts.ts"
import { signUp } from "./signup.ts"

/* A second user is a principal of the run's own: enrolled in its store, then sent as by id. */

describe("signUp", () => {
	it("signs a second user up through x-fresh-principal, as a principal its token is held for", async () => {
		const { ctx, input, seen } = await stageOf(accountsDoc(), accountsApi(accounts()))
		const session = await signUp(input, "0")
		expect(seen.map((request) => request.path)).toEqual(["/v1/register"])
		expect(session).toMatchObject({
			known: { access_token: "t1", refresh_token: "r1" },
			principal: "disposable-0",
			scope: {},
		})
		expect(typeof (session as { known: Record<string, unknown> }).known.email).toBe("string")
		expect(session).not.toHaveProperty("renew")
		expect(await ctx.store.acquire({ principal: "disposable-0", scheme: "session" })).toMatchObject({ value: "t1" })
	})

	it("keeps the parameters bound for the second user, and how its session renews", async () => {
		const renewed = exchange("POST", "/v1/refresh", { status: 200 })
		const { input } = await stageOf(accountsDoc(), accountsApi(accounts()), {
			input: {
				enroll: async (label) => ({
					id: `disposable-${label}`,
					known: {},
					renew: async () => renewed,
					scope: { org_id: "o9" },
				}),
			},
		})
		const session = await signUp(input, "1")
		expect(session).toMatchObject({ principal: "disposable-1", scope: { org_id: "o9" } })
		expect(await (session as { renew: () => Promise<unknown> }).renew()).toBe(renewed)
	})

	it("is BLOCKED with the reason when the second user cannot be signed up", async () => {
		const { input } = await stageOf(
			accountsDoc(),
			accountsApi(accounts({ answers: { "POST /v1/register": { status: 409 } } })),
		)
		expect(await signUp(input, "0")).toEqual({ blocked: expect.stringMatching(/disposable-0.*auth\.register.*409/) })
	})
})
