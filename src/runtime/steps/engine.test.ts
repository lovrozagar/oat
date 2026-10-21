import { describe, expect, it } from "vitest"
import type { OutOfBandRequest } from "../../config/types/hooks.ts"
import type { AuthStep } from "../../config/types/steps.ts"
import type { Answer } from "../checks/__fixtures__/harness.ts"
import { jwt } from "../scenario/__fixtures__/stage.ts"
import { stepStage } from "./__fixtures__/flows.ts"
import { runSteps } from "./engine.ts"

const token = jwt({ org: "o1", role: "admin" })

/** Answers by `METHOD /path`, 404 for the rest. */
const answers =
	(table: Record<string, Answer>) =>
	(method: string, path: string): Answer | undefined =>
		table[`${method} ${path}`]

/* A login or refresh step acts as nobody, and is never refreshed: that is how a refresh deadlocks. */
const ANON = { as: { anonymous: true } }

describe("runSteps: a chain", () => {
	it("binds literals, sends each step, saves what the answers carry, and returns the last answer", async () => {
		const { ctx, sent } = stepStage(
			answers({
				"GET /orgs/o1": { body: { ok: true }, headers: { "set-cookie": "sid=s1", "x-h": "h1" }, status: 200 },
				"POST /token": { body: { token }, status: 201 },
			}),
		)
		const steps: AuthStep[] = [
			{
				bind: { who: "{base}-1" },
				body: { user: "{who}" },
				operationId: "auth.token",
				saveAs: { credential: "$.token" },
			},
			{
				bind: { org: "o1" },
				operationId: "orgs.get",
				saveAs: { cookie: "cookie:sid", header: "header:x-h" },
				saveClaimsFrom: { bind: { role: "role" }, token: "credential" },
			},
		]
		const out = await runSteps(ctx, steps, { scope: { base: "al" } })
		expect(out).toEqual({
			last: {
				body: { ok: true },
				cookies: { sid: "s1" },
				headers: { "set-cookie": "sid=s1", "x-h": "h1" },
				status: 200,
			},
			scope: { base: "al", cookie: "s1", credential: token, header: "h1", org: "o1", role: "admin", who: "al-1" },
		})
		expect(sent.map(({ method, options, path }) => ({ method, options, path }))).toEqual([
			{
				method: "POST",
				options: { body: { user: "al-1" }, headers: {}, operationId: "auth.token", ...ANON },
				path: "/token",
			},
			{ method: "GET", options: { headers: {}, operationId: "orgs.get", ...ANON }, path: "/orgs/o1" },
		])
	})
})

describe("runSteps: what a step sends", () => {
	it("sends a raw step's own headers and redirect policy, and never the credential its scope holds", async () => {
		const { ctx, sent } = stepStage(() => ({ status: 303 }))
		const steps: AuthStep[] = [
			{ expect: [303], headers: { h: "1", "x-cred": "own" }, method: "GET", path: "/consume", query: { q: "1" } },
			{ body: "raw", expect: [303], method: "POST", path: "/two", redirect: "manual" },
		]
		await runSteps(ctx, steps, { scope: { credential: "c1" } })
		expect(sent.map((request) => request.options)).toEqual([
			{ headers: { h: "1", "x-cred": "own" }, query: { q: "1" }, redirect: "follow", ...ANON },
			{ body: "raw", headers: {}, redirect: "manual", ...ANON },
		])
	})

	it("sends a body under the media type the operation documents", async () => {
		const { ctx, sent } = stepStage(() => ({ status: 200 }))
		await runSteps(ctx, [{ body: { user: "al" }, operationId: "auth.login" }])
		expect(sent[0]?.options.contentType).toBe("application/x-www-form-urlencoded")
		expect(String(sent[0]?.options.body)).toBe("user=al")
	})

	it("starts from an empty scope, and has no last answer when it sends nothing", async () => {
		const { ctx } = stepStage(() => ({ status: 200 }))
		expect(await runSteps(ctx, [])).toEqual({ last: undefined, scope: {} })
	})
})

describe("runSteps: out-of-band steps", () => {
	it("asks the hook with the scope and when the triggering request was sent, and no credential", async () => {
		const asked: OutOfBandRequest[] = []
		const resolveOutOfBand = async (request: OutOfBandRequest) => {
			asked.push(request)
			return `v${asked.length}`
		}
		const { ctx } = stepStage(() => ({ status: 200 }), { hooks: { resolveOutOfBand } })
		const steps: AuthStep[] = [
			{ body: { email: "a@x.test" }, operationId: "auth.token" },
			{ outOfBand: { address: "{mail}", as: "first", kind: "otp" } },
			{ outOfBand: { address: "{mail}", as: "second", kind: "otp", sentEarlier: true } },
		]
		const { scope } = await runSteps(ctx, steps, { scope: { credential: "c", mail: "a@x.test" } })
		expect(scope).toMatchObject({ first: "v1", second: "v2" })
		const base = { address: "a@x.test", attempt: 1, kind: "otp" }
		expect(asked).toEqual([
			{ ...base, scope: { credential: "c", mail: "a@x.test" }, since: 0 },
			{ ...base, scope: { credential: "c", first: "v1", mail: "a@x.test" } },
		])
	})

	it("asks with the default schedule when given none", async () => {
		const asked: OutOfBandRequest[] = []
		const resolveOutOfBand = async (request: OutOfBandRequest) => {
			asked.push(request)
			return "v"
		}
		const { ctx } = stepStage(() => ({ status: 200 }), { hooks: { resolveOutOfBand } })
		const { outOfBand: _, ...plain } = ctx
		await runSteps(plain, [{ outOfBand: { address: "a", as: "t", kind: "otp" } }])
		expect(asked).toEqual([{ address: "a", attempt: 1, kind: "otp", scope: {} }])
	})

	it("names the principal when no hook can answer", async () => {
		const { ctx } = stepStage(() => ({ status: 200 }))
		await expect(runSteps(ctx, [{ outOfBand: { address: "a", as: "t", kind: "otp" } }])).rejects.toThrow(
			'oat: principal "alice" needs a "otp" value',
		)
	})
})

describe("runSteps: failures", () => {
	it("accepts the statuses a step expects, or any 2xx, and fails closed on the rest", async () => {
		const { ctx } = stepStage(answers({ "GET /ping": { body: { error: "x".repeat(300) }, status: 409 } }))
		expect((await runSteps(ctx, [{ expect: [409], operationId: "ping" }])).last?.status).toBe(409)
		await expect(
			runSteps(ctx, [{ operationId: "auth.token" }, { expect: [200, 201], operationId: "ping" }]),
		).rejects.toThrow('oat: principal "alice" failed at auth step 1 (POST /token): expected 2xx, got 404 — null')
		const failed = runSteps(ctx, [{ expect: [200, 201], operationId: "ping" }])
		await expect(failed).rejects.toThrow(
			`oat: principal "alice" failed at auth step 1 (GET /ping): expected 200/201, got 409 — ${JSON.stringify({ error: "x".repeat(300) }).slice(0, 200)}`,
		)
	})

	it("fails a saveAs the answer does not carry", async () => {
		const { ctx } = stepStage(answers({ "GET /ping": { body: { a: null }, status: 200 } }))
		await expect(
			runSteps(ctx, [{ operationId: "ping", saveAs: { b: "$.{field}" } }], { scope: { field: "a" } }),
		).rejects.toThrow('oat: auth step 1 for "alice" declares saveAs.b = "$.a", which is not present in the response')
		await expect(runSteps(ctx, [{ operationId: "ping", saveAs: { b: "$.z" } }])).rejects.toThrow("saveAs.b")
	})

	it("fails a claim binding without a decodable token or the claim it names", async () => {
		const { ctx } = stepStage(answers({ "GET /ping": { body: { opaque: "o", token }, status: 200 } }))
		await expect(
			runSteps(ctx, [{ operationId: "ping", saveClaimsFrom: { bind: {}, token: "$.missing" } }]),
		).rejects.toThrow('oat: auth step 1 for "alice" expected a JWT at $.missing, but it is absent or not decodable')
		await expect(
			runSteps(ctx, [{ operationId: "ping", saveClaimsFrom: { bind: {}, token: "$.opaque" } }]),
		).rejects.toThrow("expected a JWT at $.opaque")
		await expect(
			runSteps(ctx, [{ operationId: "ping", saveClaimsFrom: { bind: { t: "tenant" }, token: "$.token" } }]),
		).rejects.toThrow(
			'oat: auth step 1 binds t to claim "tenant", which the token does not carry. Available claims: org, role',
		)
	})
})
