import { describe, expect, it } from "vitest"
import type { LoginRecipe } from "../../config/types/security.ts"
import type { AuthStep } from "../../config/types/steps.ts"
import { jwtOf } from "../__fixtures__/jwt.ts"
import { answerOf, ctxOf, fakePorts, NOW, rejection } from "../__fixtures__/ports.ts"
import { acquireLogin, heldLogin } from "./login.ts"

const steps: [AuthStep, ...AuthStep[]] = [
	{ outOfBand: { address: "{principal.email}", as: "otp", kind: "otp" } },
	{
		body: { email: "{principal.email}", otp: "{otp}", password: "{principal.password}" },
		operationId: "auth.login",
		saveAs: { refreshToken: "$.refresh" },
	},
]
const login: LoginRecipe = { from: "$.token", steps }

describe("acquireLogin", () => {
	it("runs the steps once with the principal filled in, and reads the credential at `from`", async () => {
		const { ports, recorded } = fakePorts({
			run: () => Promise.resolve({ answer: answerOf({ token: "t1" }), scope: { refreshToken: "r1" } }),
		})
		const issued = await acquireLogin(ctxOf(ports), login, {})
		expect([issued.value, issued.expiresAt, issued.refresh, issued.identity]).toEqual([
			"t1",
			null,
			undefined,
			undefined,
		])
		expect(recorded.runs).toEqual([
			{
				principal: "ann",
				scope: {},
				steps: [
					{ outOfBand: { address: "ann@x.io", as: "otp", kind: "otp" } },
					{
						body: { email: "ann@x.io", otp: "{otp}", password: "pw" },
						operationId: "auth.login",
						saveAs: { refreshToken: "$.refresh" },
					},
				],
			},
		])
	})

	it("is a single attempt: a failing runner is not retried, and its reason is the failure", async () => {
		const { ports, recorded } = fakePorts({ run: () => Promise.reject(new Error("auth step 2 answered 401")) })
		expect((await rejection(acquireLogin(ctxOf(ports), login, {}))).message).toBe("auth step 2 answered 401")
		expect(recorded.runs).toHaveLength(1)
	})

	it("refuses steps that read a placeholder nothing fills, naming it, and sends nothing", async () => {
		const { ports, recorded } = fakePorts()
		const typo: LoginRecipe = { from: "$.token", steps: [{ body: { otp: "{otpp}" }, operationId: "auth.login" }] }
		expect((await rejection(acquireLogin(ctxOf(ports), typo, {}))).message).toBe(
			'login for "ann" reads {otpp} at step 1, which nothing it started from or an earlier step saved fills',
		)
		expect(recorded.runs).toEqual([])
	})

	it("reads a credential a step saved into scope when the answer has none at `from`", async () => {
		const { ports } = fakePorts({ run: () => Promise.resolve({ answer: answerOf({}), scope: { session: "s1" } }) })
		expect((await acquireLogin(ctxOf(ports), { from: "session", steps }, {})).value).toBe("s1")
	})

	it("fails with the reason when neither the answer nor the scope has a credential", async () => {
		const { ports } = fakePorts({ run: () => Promise.resolve({ answer: answerOf({}), scope: {} }) })
		expect((await rejection(acquireLogin(ctxOf(ports), login, {}))).message).toBe(
			'login for "ann" answered no credential at $.token (its answer names no content type)',
		)
	})
})

describe("acquireLogin: claims", () => {
	it("binds a claim name from the JWT into identity, and takes its lifetime from `exp`", async () => {
		const token = jwtOf({ exp: 5000, org_id: "o1", project: "p1" })
		const { ports } = fakePorts({ run: () => Promise.resolve({ answer: answerOf({ token }), scope: {} }) })
		const claims = { "scope.project_id": "project", tenant: "org_id" }
		const issued = await acquireLogin(ctxOf(ports), { ...login, claims }, {})
		expect([issued.identity, issued.expiresAt]).toEqual([{ "scope.project_id": "p1", tenant: "o1" }, 5_000_000])
	})

	it("binds a `$` path from the answer body, even when the credential is not a JWT", async () => {
		const answer = answerOf({ org: { id: "o9" }, project: { id: "p9" }, token: "opaque" })
		const { ports } = fakePorts({ run: () => Promise.resolve({ answer, scope: {} }) })
		const claims = { "scope.project_id": "$.project.id", tenant: "$.org.id" }
		const issued = await acquireLogin(ctxOf(ports), { ...login, claims }, {})
		expect(issued.identity).toEqual({ "scope.project_id": "p9", tenant: "o9" })
	})

	it("binds a mix: a claim name from the token, a `$` path from the answer body", async () => {
		const token = jwtOf({ org_id: "o1" })
		const answer = answerOf({ project: { id: "p9" }, token })
		const { ports } = fakePorts({ run: () => Promise.resolve({ answer, scope: {} }) })
		const claims = { "scope.project_id": "$.project.id", tenant: "org_id" }
		const issued = await acquireLogin(ctxOf(ports), { ...login, claims }, {})
		expect(issued.identity).toEqual({ "scope.project_id": "p9", tenant: "o1" })
	})

	it("refuses a `$` path the answer does not carry, naming it, as it does a missing claim", async () => {
		const { ports } = fakePorts({ run: () => Promise.resolve({ answer: answerOf({ token: "opaque" }), scope: {} }) })
		const recipe = { ...login, claims: { "scope.project_id": "$.project.id" } }
		expect((await rejection(acquireLogin(ctxOf(ports), recipe, {}))).message).toBe(
			'login for "ann" binds scope.project_id to "$.project.id", which the answer does not carry ' +
				"(its answer names no content type)",
		)
	})

	it("refuses claims from a value that is not a JWT, or a claim it does not carry", async () => {
		const answers = [answerOf({ token: "opaque" }), answerOf({ token: jwtOf({ sub: "u" }) })]
		const { ports } = fakePorts({
			run: () => Promise.resolve({ answer: answers.shift() ?? answerOf({}), scope: {} }),
		})
		const recipe = { ...login, claims: { tenant: "org_id" } }
		expect((await rejection(acquireLogin(ctxOf(ports), recipe, {}))).message).toBe(
			'login for "ann" binds claims, but its credential is not a JWT',
		)
		expect((await rejection(acquireLogin(ctxOf(ports), recipe, {}))).message).toBe(
			'login for "ann" binds tenant to claim "org_id", which the token does not carry (it has sub)',
		)
	})
})

describe("acquireLogin: lifetime", () => {
	it("takes `expiresIn` from the issuing answer", async () => {
		const { ports } = fakePorts({
			run: () => Promise.resolve({ answer: answerOf({ expires: 60, token: "t" }), scope: {} }),
		})
		expect((await acquireLogin(ctxOf(ports), login, { expiresIn: { from: "$.expires" } })).expiresAt).toBe(NOW + 60_000)
	})

	it("reads the credential and its lifetime from a form answer, by its media type", async () => {
		const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
		const answer = { ...answerOf("token=t-form&expires=60"), headers }
		const { ports } = fakePorts({ run: () => Promise.resolve({ answer, scope: {} }) })
		const issued = await acquireLogin(ctxOf(ports), { from: "token", steps }, { expiresIn: { from: "expires" } })
		expect([issued.value, issued.expiresAt]).toEqual(["t-form", NOW + 60_000])
	})
})

describe("acquireLogin: refresh", () => {
	it("refreshes by the refresh steps, with the current scope plus the credential, and rotates", async () => {
		const answers = [
			{ answer: answerOf({ token: "t1" }), scope: { refreshToken: "r1" } },
			{ answer: answerOf({ access: "t2", expires: 30 }), scope: { refreshToken: "r2" } },
			{ answer: answerOf({ access: "t3" }), scope: { refreshToken: "r3" } },
		]
		const { ports, recorded } = fakePorts({
			run: () => {
				const next = answers.shift()
				return next === undefined ? Promise.reject(new Error("no answer left")) : Promise.resolve(next)
			},
		})
		const refreshSteps: [AuthStep, ...AuthStep[]] = [
			{ body: { by: "{principal.email}", token: "{refreshToken}" }, operationId: "auth.refresh" },
		]
		const options = { expiresIn: { from: "$.expires" }, refresh: { from: "$.access", steps: refreshSteps } }
		const first = await acquireLogin(ctxOf(ports), login, options)
		const second = await (first.refresh as () => Promise<typeof first>)()
		const third = await (second.refresh as () => Promise<typeof first>)()
		expect([first.value, second.value, second.expiresAt, third.value]).toEqual(["t1", "t2", NOW + 30_000, "t3"])
		expect(recorded.runs.slice(1).map((run) => [run.scope, run.steps])).toEqual([
			[
				{ credential: "t1", refreshToken: "r1" },
				[{ body: { by: "ann@x.io", token: "{refreshToken}" }, operationId: "auth.refresh" }],
			],
			[
				{ credential: "t2", refreshToken: "r2" },
				[{ body: { by: "ann@x.io", token: "{refreshToken}" }, operationId: "auth.refresh" }],
			],
		])
	})
})

describe("acquireLogin: revoke", () => {
	it("revokes the session it opened by the declared operation, sending exactly that session's value", async () => {
		const { ports, recorded } = fakePorts({
			call: () => Promise.resolve(answerOf({}, 204)),
			run: () => Promise.resolve({ answer: answerOf({ token: "t1" }), scope: { refreshToken: "r1" } }),
		})
		const issued = await acquireLogin(ctxOf(ports), { ...login, revoke: "auth.logout" }, {})
		await issued.revoke?.()
		expect(recorded.calls).toEqual([
			{
				as: { principal: "ann", scheme: "jwt" },
				operationId: "auth.logout",
				scope: { credential: "t1", refreshToken: "r1" },
				value: "t1",
			},
		])
	})

	it("sends a declared body with the session's value in it, as a token revoke takes one", async () => {
		const { ports, recorded } = fakePorts({
			call: () => Promise.resolve(answerOf({}, 200)),
			run: () => Promise.resolve({ answer: answerOf({ token: "t1" }), scope: {} }),
		})
		const revoke = { body: { token: "{credential}" }, operationId: "auth.revoke" }
		await (await acquireLogin(ctxOf(ports), { ...login, revoke }, {})).revoke?.()
		expect(recorded.calls[0]).toMatchObject({ body: { token: "t1" }, operationId: "auth.revoke", value: "t1" })
	})

	it("counts a 401 as revoked, since it carried that very session, and fails on any other refusal", async () => {
		const statuses = [401, 403, 500]
		const { ports } = fakePorts({
			call: () => Promise.resolve(answerOf({}, statuses.shift() ?? 200)),
			run: () => Promise.resolve({ answer: answerOf({ token: "t1" }), scope: {} }),
		})
		const issued = await acquireLogin(ctxOf(ports), { ...login, revoke: "auth.logout" }, {})
		const revoke = issued.revoke as () => Promise<void>
		await expect(revoke()).resolves.toBeUndefined()
		expect((await rejection(revoke())).message).toBe("revoke auth.logout answered 403")
		expect((await rejection(revoke())).message).toBe("revoke auth.logout answered 500")
		expect((await acquireLogin(ctxOf(ports), login, {})).revoke).toBeUndefined()
	})
})

describe("heldLogin", () => {
	const refresh: LoginRecipe = {
		from: "$.token",
		steps: [{ body: { token: "{refresh_token}" }, operationId: "auth.refresh" }],
	}

	it("renews a credential the run was handed by the recipe's declared refresh, from the scope it came with", async () => {
		const { ports, recorded } = fakePorts({
			run: () => Promise.resolve({ answer: answerOf({ token: "t2" }), scope: { refresh_token: "r2" } }),
		})
		const held = heldLogin(
			ctxOf(ports),
			{ scope: { refresh_token: "r1" }, value: "t1" },
			{ expiresIn: 60, login, refresh },
		)
		expect([held.value, held.expiresAt]).toEqual(["t1", NOW + 60_000])
		const renewed = await (held.refresh as () => Promise<{ value: string }>)()
		expect([renewed.value, recorded.runs.map((run) => [run.steps[0], run.scope])]).toEqual([
			"t2",
			[
				[
					{ body: { token: "{refresh_token}" }, operationId: "auth.refresh" },
					{ credential: "t1", refresh_token: "r1" },
				],
			],
		])
	})

	it("refuses a refresh that reads a value the session never carried, naming it, and sends nothing", async () => {
		const { ports, recorded } = fakePorts()
		const held = heldLogin(ctxOf(ports), { scope: { access_token: "t1" }, value: "t1" }, { login, refresh })
		expect((await rejection((held.refresh as () => Promise<unknown>)())).message).toBe(
			'refresh for "ann" reads {refresh_token} at step 1, which nothing it started from or an earlier step saved fills',
		)
		expect(recorded.runs).toEqual([])
	})

	it("has no refresh of its own when the recipe declares none, so the store signs in again", () => {
		const { ports } = fakePorts()
		expect(heldLogin(ctxOf(ports), { scope: {}, value: "t1" }, { login }).refresh).toBeUndefined()
	})
})
