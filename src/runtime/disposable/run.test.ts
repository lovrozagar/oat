import { describe, expect, it } from "vitest"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import { accounts, accountsApi, accountsDoc, stageOf } from "./__fixtures__/accounts.ts"
import { runDisposableOps } from "./run.ts"

const needs = (input: { grades: { needs: Map<string, Set<string>> } }, id: string) => [
	...(input.grades.needs.get(id) ?? []),
]

describe("runDisposableOps", () => {
	it("runs each destructive operation as a second user, and spares the suite caller", async () => {
		const state = accounts()
		const { input, seen } = await stageOf(accountsDoc(), accountsApi(state))
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
		const { input, seen } = await stageOf(doc, accountsApi(accounts()), { input: { checksRun: undefined } })
		await runDisposableOps(input)
		expect(seen.filter((request) => request.path === "/v1/register")).toHaveLength(2)
	})

	it("runs only targeted operations in a targeted run, and nothing when none is", async () => {
		const { input, seen } = await stageOf(accountsDoc(), accountsApi(accounts()), {
			input: { inScope: (id) => id === "auth.logout", mode: "targeted" },
		})
		await runDisposableOps(input)
		expect(seen.some((request) => request.path.startsWith("/v1/keys"))).toBe(false)
		const none = await stageOf(accountsDoc(), accountsApi(accounts()), {
			input: { inScope: () => false, mode: "targeted" },
		})
		await runDisposableOps(none.input)
		expect(none.input.checksRun?.size).toBe(0)
	})
})

describe("runDisposableOps on what it skips", () => {
	it("skips every operation without a caller read", async () => {
		const { input, seen } = await stageOf(accountsDoc({ "/v1/me": {} }), accountsApi(accounts()))
		await runDisposableOps(input)
		expect(seen).toEqual([])
		expect(needs(input, "auth.logout")).toEqual(["no caller read (an identity: self read)"])
	})

	it("skips an operation whose second user cannot sign up", async () => {
		const refused = await stageOf(accountsDoc({ "/v1/register": {} }), accountsApi(accounts()))
		await runDisposableOps(refused.input)
		/* The reason is the run's, passed on: here, the document has no x-fresh-principal operation. */
		expect(needs(refused.input, "keys.delete")).toEqual([
			expect.stringMatching(/^the second user could not sign up: .*disposable-shared.*x-fresh-principal/),
		])
		const broken = await stageOf(accountsDoc(), () => {
			throw new Error("register is down")
		})
		await runDisposableOps(broken.input)
		expect(needs(broken.input, "auth.logout")[0]).toMatch(/^the second user could not sign up: /)
		const odd = await stageOf(accountsDoc(), accountsApi(accounts()), {
			run: { hooks: { resolveInput: () => Promise.reject("no input") } },
		})
		await runDisposableOps(odd.input)
		expect(needs(odd.input, "auth.logout")).toEqual(["the second user could not sign up: no input"])
	})
})

describe("runDisposableOps: the second user's credential", () => {
	it("goes where the operation's scheme places it: an apiKey signup token in its header, not a bearer one", async () => {
		const apiKey = { securitySchemes: { key: { in: "header", name: "x-api-key", type: "apiKey" } } }
		const { input, seen } = await stageOf(accountsDoc({}, apiKey), accountsApi(accounts()))
		await runDisposableOps(input)
		const deleted = seen.find((request) => request.method === "DELETE")
		expect([deleted?.headers["x-api-key"], deleted?.headers.authorization]).toEqual(["t1", undefined])
		expect(input.findings.findings).toEqual([])
	})

	it("lets any other failure of the second user's operation through, unswallowed", async () => {
		const api = accountsApi(accounts())
		const broken: Responder = (method, path, options) => {
			if (path === "/v1/keys" && method === "GET") throw new Error("socket closed")
			return api(method, path, options)
		}
		const { input } = await stageOf(accountsDoc(), broken, {
			input: { inScope: (id) => id === "keys.delete", mode: "targeted" },
		})
		await expect(runDisposableOps(input)).rejects.toThrow("socket closed")
	})

	it("never renews the second user by signing up again: a 401 with no declared refresh skips the operation", async () => {
		const api = accountsApi(accounts())
		let listed = 0
		const once: Responder = (method, path, options) =>
			path === "/v1/keys" && method === "GET" && (listed += 1) === 1 ? { status: 401 } : api(method, path, options)
		const { input, seen } = await stageOf(accountsDoc(), once, {
			input: { inScope: (id) => id === "keys.delete", mode: "targeted" },
		})
		await runDisposableOps(input)
		expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /v1/register", "GET /v1/keys"])
		expect(needs(input, "keys.delete")).toEqual(["keys.list answered 401"])
	})

	it("skips the next operation of a second user its renewal BLOCKED, and sends it nothing", async () => {
		const doc = accountsDoc({
			"/v1/tokens": {
				post: { operationId: "tokens.rotate", responses: { "200": { description: "ok" } }, "x-destructive": true },
			},
		})
		const api = accountsApi(accounts())
		/* The shared second user's first read is refused; a renewal would sign up again, so it is blocked. */
		const refused: Responder = (method, path, options) =>
			path === "/v1/keys" && method === "GET" ? { status: 401 } : api(method, path, options)
		const { input, seen } = await stageOf(doc, refused, {
			input: { inScope: (id) => id === "keys.delete" || id === "tokens.rotate", mode: "targeted" },
		})
		await runDisposableOps(input)
		const blocked = "renewing disposable-shared/session would sign up again; declare a refresh"
		expect(needs(input, "tokens.rotate")).toEqual([blocked])
		/* tokens.rotate is refused at resolve: the shared user's only requests are its signup and the refused read. */
		expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /v1/register", "GET /v1/keys"])
		expect(input.grades.evidence.has("tokens.rotate")).toBe(false)
	})
})
