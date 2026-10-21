import { describe, expect, it } from "vitest"
import { modelOf, type Sent } from "../../__fixtures__/harness.ts"
import type { OperationCheck } from "../../core/check.ts"
import { contextOf, notesApi, notesDoc, optionsFor } from "../../../run/__fixtures__/api.ts"
import { runWriteSecurity } from "../../../run/security.ts"
import { actorOf, operationContextFor } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { LOGIN_ATTEMPTS, loginThrottled } from "./auth-login-throttled.ts"

/* Opt-in: failed logins for one identity that does not exist must, before the cap, answer 429. */

const model = modelOf(securedDoc())
const alpha = actorOf("alpha", { scope: { project_id: "proj_a" }, tenant: "proj_a" })
const JWT = { issue: "auth.login", kind: "login" } as const

/* A login that fails, and answers 429 from the `limit`-th failure on; `ok` lets a login succeed. */
function staged(operationId: string, { limit = 6, ok = false, recipes = { jwt: JWT } as object } = {}) {
	let failures = 0
	const respond = (sent: Sent) => {
		if (sent.path !== "/auth/login") return undefined
		if (ok) return { status: 200 }
		failures += 1
		return failures >= limit ? { headers: { "retry-after": "30" }, status: 429 } : { status: 401 }
	}
	return operationContextFor(model, operationId, {
		principals: [alpha],
		probe: { recipes: recipes as never },
		respond,
	})
}

describe("auth.login-throttled", () => {
	it("stops at the first 429, every attempt the same nonexistent identity, anonymous", async () => {
		const stage = staged("auth.login")
		expect(await runOperationCheck(loginThrottled, stage.ctx)).toEqual({
			kind: "asserted",
			note: "a login for one identity was throttled (429) after 5 failures",
		})
		expect(stage.sent).toHaveLength(6)
		const bodies = stage.sent.map((s) => JSON.stringify(s.options.body))
		expect(new Set(bodies).size).toBe(1)
		expect(stage.sent.every((s) => "anonymous" in s.options.as && s.options.probe === true)).toBe(true)
		expect(stage.sent.map((s) => [s.method, s.path, s.options.operationId])[0]).toEqual([
			"POST",
			"/auth/login",
			"auth.login",
		])
		expect([loginThrottled.mutates, loginThrottled.mutatesCredentials, loginThrottled.optIn]).toEqual([
			true,
			true,
			true,
		])
	})

	it("logs in as an unmistakable identity no account can hold: an RFC 2606 .invalid email, else a marked name", async () => {
		const stage = staged("auth.login")
		await runOperationCheck(loginThrottled, stage.ctx)
		expect(stage.ctx.nonce).toBe("test")
		expect(stage.sent[0]?.options.body).toEqual({
			email: "oat-nonexistent-test@example.invalid",
			password: "oat-nonexistent-test",
		})
	})

	it("leaves a field that is not a string as the schema draws it", async () => {
		const doc = securedDoc()
		const paths = (doc as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths
		const login = paths["/auth/login"]?.post as Record<string, unknown>
		const schema = {
			properties: { remember: { const: true, type: "boolean" }, username: { type: "string" } },
			required: ["username", "remember"],
			type: "object",
		}
		login.requestBody = { content: { "application/json": { schema } }, required: true }
		const stage = operationContextFor(modelOf(doc), "auth.login", {
			principals: [alpha],
			probe: { recipes: { jwt: JWT } },
			respond: () => ({ status: 429 }),
		})
		await runOperationCheck(loginThrottled, stage.ctx)
		expect(stage.sent[0]?.options.body).toEqual({ remember: true, username: "oat-nonexistent-test" })
	})
})

describe("auth.login-throttled (3)", () => {
	it("reports a security finding when the cap passes with no 429", async () => {
		const stage = staged("auth.login", { limit: 100 })
		expect(await runOperationCheck(loginThrottled, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.sent).toHaveLength(LOGIN_ATTEMPTS)
		expect(LOGIN_ATTEMPTS).toBe(8)
		expect(stage.findings.findings).toMatchObject([
			{
				check: "auth.login-throttled",
				detail: expect.stringMatching(/8 failed logins.*auth\.login.*no 429/),
				summary: "repeated failed logins are never throttled",
			},
		])
		expect(stage.findings.findings[0]?.evidence).toHaveLength(LOGIN_ATTEMPTS)
	})

	it("is unresolved when a login for the nonexistent identity succeeds", async () => {
		expect(await runOperationCheck(loginThrottled, staged("auth.login", { ok: true }).ctx)).toEqual({
			kind: "unresolved",
			reason: "a login for an identity that does not exist answered 200, so its failures cannot be counted",
		})
	})
})

describe("auth.login-throttled (2)", () => {
	it("stands down off the login step, for a non-login recipe or without declared security", async () => {
		const open = operationContextFor(modelOf(undeclaredDoc()), "auth.login", { principals: [alpha] })
		const outcomes = await Promise.all(
			[
				staged("notes.list"),
				staged("auth.login", { recipes: { jwt: { issue: "auth.login", kind: "mint" } } }),
				staged("auth.refresh", { recipes: { jwt: { issue: "auth.refresh", kind: "login" } } }),
				open,
			].map((stage) => runOperationCheck(loginThrottled, stage.ctx)),
		)
		expect(outcomes.map((outcome) => ("reason" in outcome ? outcome.reason : outcome.kind))).toEqual([
			"the issue operation of a recipe; this check runs on auth.login",
			"apiKey: no apiKey recipe in this test; jwt: mint recipes have no login step",
			"a request body schema for auth.refresh, to build a failed login from",
			"the document declares no security; add an overlay",
		])
	})
	it("is skipped by the security stage, saying how to opt in, unless the config switches it on", async () => {
		const options = optionsFor(notesApi(notesDoc(), []))
		const ctx = await contextOf(options)
		const before = options.seen.length
		await runWriteSecurity(ctx, [loginThrottled as OperationCheck])
		expect(options.seen.length).toBe(before)
		const reasons = new Set(ctx.state.checksSkipped.map((skip) => skip.needs))
		expect([...reasons]).toEqual(['opt in with checks: { "auth.login-throttled": true }'])
	})
})
