import { describe, expect, it, vi } from "vitest"
import type { Hooks } from "../config/types/hooks.ts"
import type { AuthFlow, PrincipalAuthResult } from "../config/types/principals.ts"
import type { AuthStep } from "../config/types/steps.ts"
import { Redactor } from "../security/redact.ts"
import {
	acquireLooksLikeRegister,
	AuthRefreshRequiredError,
	bearerHeaders,
	createPrincipal,
	type PrincipalRuntime,
	resolvePrincipalAuthValue,
	runAuthSteps,
} from "./auth.ts"
import type { Responder, Sent } from "./checks/__fixtures__/harness.ts"
import { jwt } from "./scenario/__fixtures__/stage.ts"
import { stepStage } from "./steps/__fixtures__/flows.ts"
import { interpolate } from "./steps/interpolate.ts"
import type { StepContext } from "./steps/request.ts"

/*
 * A step that uploads a file sends its bytes as the body. Interpolation fills `{name}` in text; it
 * must hand bytes on untouched, or the upload arrives as a JSON object of numbered keys.
 */

describe("interpolate", () => {
	it("hands bytes on as they are", () => {
		const bytes = new Uint8Array([137, 80, 78, 71])
		expect(interpolate(bytes, { who: "oat" })).toBe(bytes)
		const buffer = bytes.buffer
		expect(interpolate(buffer, {})).toBe(buffer)
		const blob = new Blob([bytes], { type: "image/png" })
		expect(interpolate(blob, {})).toBe(blob)
	})

	it("still fills text inside objects", () => {
		expect(interpolate({ name: "{who}", tags: ["{who}"] }, { who: "oat" })).toEqual({ name: "oat", tags: ["oat"] })
	})
})

describe("bearerHeaders", () => {
	it("sends a fresh principal's token as a bearer authorization header", () => {
		expect(bearerHeaders("tok")).toEqual({ authorization: "Bearer tok" })
	})
})

/** A step context over `respond` whose client has a redactor, as a principal needs. */
function principalStage(respond: Responder, hooks: Hooks = {}): { ctx: StepContext; sent: Sent[] } {
	const { ctx, sent } = stepStage(respond, { hooks })
	return { ctx: { ...ctx, client: Object.assign(ctx.client, { redactor: new Redactor() }) }, sent }
}

/** Answers `POST /token` with the next of `tokens`, and the rest with 200. */
function issuing(tokens: string[]): Responder {
	let issued = 0
	return (method, path) => {
		if (`${method} ${path}` !== "POST /token") return { status: 200 }
		issued += 1
		return { body: { expires_in: 60, token: tokens[issued - 1] }, status: 200 }
	}
}

const login: AuthFlow = { credentialFrom: "$.token", steps: [{ operationId: "auth.token" }] }

describe("AuthRefreshRequiredError", () => {
	it("names the principal whose signup cannot be re-run as a refresh", () => {
		const error = new AuthRefreshRequiredError("p")
		expect(error).toMatchObject({ code: "AUTH_REFRESH_REQUIRED", name: "AuthRefreshRequiredError" })
		expect(error.message).toMatch(/^oat: principal "p" cannot refresh/)
	})
})

describe("runAuthSteps", () => {
	it("reads the credential and its lifetime from the last answer", async () => {
		vi.useFakeTimers({ now: 1_000 })
		const { ctx } = principalStage(issuing(["t1"]))
		const flow = { ...login, expiresInFrom: "$.expires_in" }
		expect(await runAuthSteps(flow.steps, flow, ctx)).toEqual({ credential: "t1", expiresAt: 61_000, scope: {} })
		vi.useRealTimers()
	})

	it("sends the bound credential under the flow's header and template, or a bearer authorization", async () => {
		const { ctx, sent } = principalStage(() => ({ status: 200 }))
		const step: AuthStep = { method: "GET", path: "/consume", redirect: "manual" }
		await runAuthSteps([step], { ...login, header: "x-key", template: "Key {credential}" }, ctx, { credential: "c" })
		await runAuthSteps([step], login, ctx, { credential: "c" })
		await runAuthSteps([step], login, ctx, { credential: "", token: "t" }).catch(() => undefined)
		expect(sent.map((request) => request.options.headers)).toEqual([
			{ "x-key": "Key c" },
			{ authorization: "Bearer c" },
			{},
		])
	})

	it("fails a chain that yields no credential", async () => {
		const { ctx } = principalStage(() => ({ body: {}, status: 200 }))
		await expect(runAuthSteps(login.steps, login, ctx)).rejects.toThrow(
			'oat: principal "alice" completed its chain but $.token did not yield a credential',
		)
	})
})

/** A flow of `steps`. */
const flowOf = (...steps: [AuthStep, ...AuthStep[]]): AuthFlow => ({ credentialFrom: "$.t", steps })

describe("acquireLooksLikeRegister", () => {
	it("is true when the first HTTP step names a signup operation or path", () => {
		const { ctx } = principalStage(() => ({ status: 200 }))
		const wait: AuthStep = { outOfBand: { address: "a", as: "t", kind: "otp" } }
		expect(acquireLooksLikeRegister(flowOf(wait, { operationId: "user.signUp" }), ctx.model)).toBe(true)
		expect(acquireLooksLikeRegister(flowOf({ method: "POST", path: "/register" }), ctx.model)).toBe(true)
		expect(acquireLooksLikeRegister(flowOf({ operationId: "auth.token" }), ctx.model)).toBe(false)
		expect(acquireLooksLikeRegister(flowOf({ operationId: "missing" }), ctx.model)).toBe(false)
		expect(acquireLooksLikeRegister(flowOf({ method: "POST", path: "/token" }), ctx.model)).toBe(false)
		expect(acquireLooksLikeRegister(flowOf(wait), ctx.model)).toBe(false)
	})
})

describe("resolvePrincipalAuthValue", () => {
	const quick = { label: 'principal "p"', outOfBand: { attempts: 3, initialMs: 1, maxMs: 1 } }

	it("polls the hook until it returns a credential", async () => {
		const answers = [null, { credential: "" }, { credential: "c" }]
		const value = await resolvePrincipalAuthValue(async () => answers.shift() ?? null, "k", quick)
		expect(value).toEqual({ credential: "c" })
	})

	it("refuses without a hook, and gives up after the last attempt", async () => {
		await expect(resolvePrincipalAuthValue(undefined, "k", quick)).rejects.toThrow(
			'oat: principal "p" declares auth.fromHook "k", but the config has no resolvePrincipalAuth hook.',
		)
		await expect(resolvePrincipalAuthValue(async () => null, "k", quick)).rejects.toThrow(
			'oat: resolvePrincipalAuth("k") returned no credential for principal "p" after 3 attempts',
		)
	})
})

describe("createPrincipal from a hook", () => {
	it("sends the harvested credential, knows what it issued, and adopts a later one", async () => {
		const hooks: Hooks = { resolvePrincipalAuth: async () => ({ credential: "h1", refreshToken: "r" }) }
		const { ctx } = principalStage(() => ({ status: 200 }), hooks)
		const principal = await createPrincipal("p", { fromHook: "k", header: "x-key", template: "K {credential}" }, ctx)
		expect(principal.headers()).toEqual({ "x-key": "K h1" })
		expect(principal.scope).toEqual({ refreshToken: "r" })
		expect(principal.expiresAt).toBeNull()
		principal.adoptCredential("")
		principal.adoptCredential(jwt({ exp: 7 }))
		expect(principal.credential()).toBe(jwt({ exp: 7 }))
		expect(principal.expiresAt).toBe(7_000)
		expect(principal.matches({ "x-key": "K h1" })).toBe(true)
		expect(principal.matches({ "x-key": "K other" })).toBe(false)
		expect(principal.matches({})).toBe(false)
	})

	it("takes its expiry from the hook, the assumed lifetime, or the token, and re-harvests when stale", async () => {
		vi.useFakeTimers({ now: 0 })
		const answers: PrincipalAuthResult[] = [
			{ credential: "a", expiresIn: 10 },
			{ credential: "b" },
			{ credential: jwt({ exp: 99 }) },
		]
		const hooks: Hooks = { resolvePrincipalAuth: async () => answers.shift() ?? null }
		const { ctx } = principalStage(() => ({ status: 200 }), hooks)
		const principal = await createPrincipal("p", { assumeTtlMs: 5, fromHook: "k", refreshBufferMs: 1_000 }, ctx)
		expect(principal.expiresAt).toBe(10_000)
		await principal.refreshIfStale()
		expect(principal.credential()).toBe("a")
		vi.setSystemTime(9_500)
		await Promise.all([principal.refreshIfStale(), principal.refreshIfStale()])
		expect(principal.headers()).toEqual({ authorization: "Bearer b" })
		expect(principal.expiresAt).toBe(9_505)
		const bare = await createPrincipal("q", { fromHook: "k" }, ctx)
		expect(bare.expiresAt).toBe(99_000)
		await bare.refreshIfStale()
		vi.useRealTimers()
	})
})

describe("createPrincipal from steps", () => {
	it("signs in, keeps its address, and adopts a later credential", async () => {
		const { ctx } = principalStage(issuing(["t1"]))
		const flow: AuthFlow = { ...login, steps: [{ bind: { email: "a@x.test" }, operationId: "auth.token" }] }
		const principal = await createPrincipal("p", flow, ctx)
		expect(principal).toMatchObject({ address: "a@x.test", expiresAt: null, scope: { email: "a@x.test" } })
		expect(principal.headers()).toEqual({ authorization: "Bearer t1" })
		principal.adoptCredential("")
		principal.adoptCredential("t9")
		expect(principal.matches({ authorization: "Bearer t1" })).toBe(true)
		expect(principal.matches({ authorization: "Bearer t9" })).toBe(true)
		expect(principal.matches({})).toBe(false)
		expect(principal.expiresAt).toBeNull()
	})

	it("refreshes through its refresh steps without the stale credential, once for concurrent callers", async () => {
		const { ctx, sent } = principalStage(issuing(["t1", "t2"]))
		const flow: AuthFlow = {
			...login,
			refresh: { steps: [{ body: { old: "{credential}" }, operationId: "auth.token" }] },
			steps: [{ operationId: "auth.token", saveAs: { credential: "$.token" } }],
		}
		const principal = await createPrincipal("p", flow, ctx)
		await principal.refreshIfStale()
		await Promise.all([principal.refreshIfStale(true), principal.refreshIfStale(true)])
		expect(principal.credential()).toBe("t2")
		expect(sent.map((request) => request.options.body)).toEqual([undefined, { old: "{credential}" }])
	})

	it("re-runs a sign-in flow when stale, but refuses to re-run a signup", async () => {
		vi.useFakeTimers({ now: 0 })
		const { ctx, sent } = principalStage(issuing(["t1", "t2"]))
		const principal = await createPrincipal("p", { ...login, assumeTtlMs: 10, refreshBufferMs: 20 }, ctx)
		await principal.refreshIfStale()
		expect(principal.credential()).toBe("t2")
		expect(sent).toHaveLength(2)
		const signup = principalStage(() => ({ body: { token: "s1" }, status: 200 }))
		const flow: AuthFlow = { credentialFrom: "$.token", steps: [{ method: "POST", path: "/signup" }] }
		const registered = await createPrincipal("s", flow, signup.ctx)
		await expect(registered.refreshIfStale(true)).rejects.toThrow(AuthRefreshRequiredError)
		vi.useRealTimers()
	})
})

describe("a refresh's own requests", () => {
	it("do not wait on the refresh they belong to", async () => {
		const pending: Promise<void>[] = []
		let principal: PrincipalRuntime | undefined
		const tokens = issuing(["t1", "t2"])
		const { ctx, sent } = principalStage((method, path, options) => {
			if (principal !== undefined) pending.push(principal.refreshIfStale(true))
			return tokens(method, path, options)
		})
		principal = await createPrincipal("p", login, ctx)
		await principal.refreshIfStale(true)
		await Promise.all(pending)
		expect(sent).toHaveLength(2)
		expect(principal.credential()).toBe("t2")
	})
})
