import { describe, expect, it } from "vitest"
import { accounts, accountsApi, accountsDoc, stageOf } from "./__fixtures__/accounts.ts"
import { runDisposableOps } from "./run.ts"

const needs = (input: { grades: { needs: Map<string, Set<string>> } }, id: string) => [
	...(input.grades.needs.get(id) ?? []),
]

describe("runDisposableOps", () => {
	it("runs each destructive operation as a second user, and spares the suite caller", async () => {
		const state = accounts()
		const { input, seen } = stageOf(accountsDoc(), accountsApi(state))
		await runDisposableOps(input)
		expect(input.checksRun?.has("auth.destructive-spares-the-caller")).toBe(true)
		expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
			"POST /v1/register",
			"GET /v1/keys",
			"DELETE /v1/keys/k1",
			"GET /v1/me",
			"GET /v1/keys",
			"POST /v1/register",
			"POST /v1/logout",
			"GET /v1/me",
			"GET /v1/me",
		])
		expect(input.findings.findings).toEqual([])
		expect(input.grades.evidence.get("keys.delete")?.observation).toMatchObject({ absent: true, value: "k1" })
		expect(input.grades.evidence.get("auth.logout")?.observation).toMatchObject({ status: 401 })
	})

	it("shares one second user between operations that leave the session standing", async () => {
		const doc = accountsDoc({
			"/v1/tokens": {
				post: { operationId: "tokens.rotate", responses: { "200": { description: "ok" } }, "x-destructive": true },
			},
		})
		const { input, seen } = stageOf(doc, accountsApi(accounts()), { checksRun: undefined })
		await runDisposableOps(input)
		expect(seen.filter((request) => request.path === "/v1/register")).toHaveLength(2)
	})

	it("runs only targeted operations in a targeted run, and nothing when none is", async () => {
		const { input, seen } = stageOf(accountsDoc(), accountsApi(accounts()), {
			inScope: (id) => id === "auth.logout",
			mode: "targeted",
		})
		await runDisposableOps(input)
		expect(seen.some((request) => request.path.startsWith("/v1/keys"))).toBe(false)
		const none = stageOf(accountsDoc(), accountsApi(accounts()), { inScope: () => false, mode: "targeted" })
		await runDisposableOps(none.input)
		expect(none.input.checksRun?.size).toBe(0)
	})
})

describe("runDisposableOps on what it skips", () => {
	it("skips every operation without a caller read", async () => {
		const { input, seen } = stageOf(accountsDoc({ "/v1/me": {} }), accountsApi(accounts()))
		await runDisposableOps(input)
		expect(seen).toEqual([])
		expect(needs(input, "auth.logout")).toEqual(["no caller read (an identity: self read)"])
	})

	it("skips an operation whose second user cannot sign up", async () => {
		const refused = stageOf(accountsDoc({ "/v1/register": {} }), accountsApi(accounts()))
		await runDisposableOps(refused.input)
		expect(needs(refused.input, "keys.delete")).toEqual([
			"no way to sign up a second user (an auth flow or x-fresh-principal)",
		])
		const broken = stageOf(accountsDoc(), () => {
			throw new Error("register is down")
		})
		await runDisposableOps(broken.input)
		expect(needs(broken.input, "auth.logout")[0]).toMatch(/^the second user could not sign up: /)
		const odd = stageOf(accountsDoc(), accountsApi(accounts()), {
			resolveInput: () => Promise.reject("no input"),
		})
		await runDisposableOps(odd.input)
		expect(needs(odd.input, "auth.logout")).toEqual(["the second user could not sign up: no input"])
	})
})
