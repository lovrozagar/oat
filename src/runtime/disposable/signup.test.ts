import { describe, expect, it } from "vitest"
import type { Hooks } from "../../config/types/hooks.ts"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { accounts, accountsApi, accountsDoc, signupFlow, stageOf } from "./__fixtures__/accounts.ts"
import { answered, signUp } from "./signup.ts"

const hooks: Hooks = {}

describe("answered", () => {
	it("keeps a signup's top-level strings", () => {
		expect(answered(exchange("POST", "/r", { body: { a: "x", n: 1, o: {} }, status: 201 }))).toEqual({ a: "x" })
		expect(answered(exchange("POST", "/r", { body: ["x"], status: 201 }))).toEqual({})
		expect(answered(exchange("POST", "/r", { body: "x", status: 201 }))).toEqual({})
		expect(answered(exchange("POST", "/r", { status: 201 }))).toEqual({})
		expect(answered(undefined)).toEqual({})
	})
})

describe("signUp through the suite principal's flow", () => {
	it("signs up a fresh address and keeps what it sent, answered and bound", async () => {
		const state = accounts()
		const { input, seen } = stageOf(accountsDoc(), accountsApi(state), {
			authFlow: signupFlow(),
			hooks,
			outOfBand: { attempts: 1 },
			rootsFromFlow: { org_id: "refreshToken", team_id: "absent" },
		})
		const session = await signUp(input, "shared")
		expect(seen[0]?.body).toEqual({ email: "oat-disp-n0-shared@example.test", plan: "free" })
		expect(session?.headers()).toEqual({ authorization: "Bearer t1" })
		expect(session?.known).toMatchObject({
			access_token: "t1",
			address: "oat-disp-n0-shared@example.test",
			email: "oat-disp-n0-shared@example.test",
			plan: "free",
			refreshToken: "r1",
		})
		expect(session?.roots).toEqual({ org_id: "r1" })
		const renewed = await session?.renew?.()
		expect(renewed?.status).toBe(200)
	})

	it("renews to what the refresh answered, refused or not", async () => {
		const state = accounts({ answers: { "POST /v1/refresh": { status: 401 } } })
		const { input } = stageOf(accountsDoc(), accountsApi(state), { authFlow: signupFlow(), hooks, nonce: undefined })
		const session = await signUp(input, "1")
		expect(session?.known.email).toBe("oat-disp-user-1@example.test")
		expect((await session?.renew?.())?.status).toBe(401)
	})

	it("has no renew without a declared refresh, and no session without a credential", async () => {
		const { refresh: _, ...noRefresh } = signupFlow()
		const plain = stageOf(accountsDoc(), accountsApi(accounts()), { authFlow: noRefresh, hooks })
		expect((await signUp(plain.input, "s"))?.renew).toBeUndefined()
		const empty = stageOf(
			accountsDoc(),
			accountsApi(accounts({ answers: { "POST /v1/register": { body: { access_token: "" }, status: 201 } } })),
			{ authFlow: signupFlow(), hooks },
		)
		await expect(signUp(empty.input, "s")).rejects.toThrow()
	})
})

describe("signUp through a flow of several steps", () => {
	it("keeps the body fields of the steps that send one", async () => {
		const flow = signupFlow()
		const withRead = { ...flow, steps: [...flow.steps, { expect: [401], operationId: "profile.read" }] } as typeof flow
		const { input, seen } = stageOf(accountsDoc(), accountsApi(accounts()), { authFlow: withRead, hooks })
		const session = await signUp(input, "s")
		expect(seen.map((request) => request.path)).toEqual(["/v1/register", "/v1/me"])
		expect(session?.known).toMatchObject({ plan: "free" })
	})
})

describe("signUp through x-fresh-principal", () => {
	it("registers with a schema-built body and reads the access token", async () => {
		const { input, seen } = stageOf(accountsDoc(), accountsApi(accounts()))
		const session = await signUp(input, "0")
		expect(seen.map((request) => request.path)).toEqual(["/v1/register"])
		expect(session?.headers()).toEqual({ authorization: "Bearer t1" })
		expect(session?.known).toMatchObject({ access_token: "t1", refresh_token: "r1" })
		expect(typeof session?.known.email).toBe("string")
		expect(session?.roots).toEqual({})
	})

	it("takes the flow's way only when it signs up an address and hooks are given", async () => {
		const login = { credentialFrom: "$.access_token", steps: [{ operationId: "auth.register" }] }
		const { input, seen } = stageOf(accountsDoc(), accountsApi(accounts()), {
			authFlow: login as never,
			hooks,
			nonce: undefined,
			resolveInput: async ({ field }) => (field === "email" ? "picked@x.test" : null),
			seed: undefined,
		})
		await signUp(input, "0")
		expect(seen[0]?.body).toEqual({ email: "picked@x.test" })
		const noHooks = stageOf(accountsDoc(), accountsApi(accounts()), { authFlow: signupFlow() })
		await signUp(noHooks.input, "0")
		expect(noHooks.seen[0]?.body).not.toEqual({ email: "oat-disp-n0-0@example.test", plan: "free" })
	})

	it("is null when there is no register, it is refused, or it answers no token", async () => {
		const none = stageOf(accountsDoc({ "/v1/register": {} }), accountsApi(accounts()))
		expect(await signUp(none.input, "0")).toBeNull()
		for (const answer of [
			{ status: 409 },
			{ body: { access_token: "" }, status: 201 },
			{ body: {}, status: 201 },
			{ status: 302 },
		]) {
			const { input } = stageOf(accountsDoc(), accountsApi(accounts({ answers: { "POST /v1/register": answer } })))
			expect(await signUp(input, "0")).toBeNull()
		}
	})

	it("sends an empty body to a register that documents none", async () => {
		const bare = accountsDoc({
			"/v1/register": {
				post: { operationId: "auth.register", responses: { "201": { description: "ok" } }, "x-fresh-principal": true },
			},
		})
		const { input, seen } = stageOf(bare, accountsApi(accounts()))
		const session = await signUp(input, "0")
		expect(seen[0]?.body).toEqual({})
		expect(session?.known).toEqual({ access_token: "t1", refresh_token: "r1" })
	})
})
