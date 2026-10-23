import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../client/credential-source.ts"
import type { Recipe } from "../config/types/security.ts"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import type { Answer, Responder } from "./checks/__fixtures__/harness.ts"
import { actingClient } from "./__fixtures__/acting-client.ts"
import { transport } from "./run/__fixtures__/api.ts"
import { driveAsync } from "./async.ts"

/*
 * A job outlives the credential it started with. Every poll resolves alpha's credential afresh from
 * the store, so a lapsed one is renewed before a poll would send it, and a renewal that fails stops
 * the poll instead of sending the dead token.
 */

const step = (operationId: string) => ({
	post: {
		operationId,
		requestBody: { content: { "application/json": { schema: { type: "object" } } } },
		responses: { "200": { description: "ok" } },
		security: [],
	},
})

const SPEC = {
	components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
	info: { title: "async-refresh", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/auth/refresh": step("auth.refreshToken"),
		"/v1/auth/register": step("auth.register"),
		"/v1/jobs": { post: { operationId: "job.start", responses: { "202": { description: "accepted" } } } },
		"/v1/jobs/{id}": { get: { operationId: "job.poll", responses: { "200": { description: "ok" } } } },
	},
	security: [{ bearer: [] }],
} as OpenApiDocument

const model = buildModel(dereference(SPEC).doc)

/* Signs up for a token that lives `access_token_expires_in` seconds, and renews it by the refresh token. */
const signup: Recipe = {
	expiresIn: { from: "$.access_token_expires_in" },
	login: {
		from: "$.access_token",
		steps: [
			{
				body: { email: "oat@example.test" },
				operationId: "auth.register",
				saveAs: { refreshToken: "$.refresh_token" },
			},
		],
	},
	refresh: {
		from: "$.access_token",
		steps: [
			{
				body: { refresh_token: "{refreshToken}" },
				operationId: "auth.refreshToken",
				saveAs: { refreshToken: "$.refresh_token" },
			},
		],
	},
}

const authOf = (options: Parameters<Responder>[2]): string =>
	(options.headers as Record<string, string> | undefined)?.["authorization"] ?? ""

/*
 * A backend whose sign-up token lives `expiresIn` seconds and whose refresh issues t2; job_1 is
 * accepted on POST and reads done from its second poll on.
 */
function jobs(expiresIn: number) {
	const seen = { pollAuth: [] as string[], refreshHits: [] as string[], startAuth: [] as string[] }
	let polls = 0
	const routes: Record<string, (options: Parameters<Responder>[2]) => Answer> = {
		"GET /v1/jobs/job_1": (options) => {
			seen.pollAuth.push(authOf(options))
			polls += 1
			return { body: { status: polls >= 2 ? "done" : "running" }, status: 200 }
		},
		"POST /v1/auth/refresh": (options) => {
			seen.refreshHits.push((options.body as { refresh_token?: string }).refresh_token ?? "")
			return { body: { access_token: "t2", access_token_expires_in: 90, refresh_token: "rt-2" }, status: 200 }
		},
		"POST /v1/auth/register": () => ({
			body: { access_token: "t1", access_token_expires_in: expiresIn, refresh_token: "rt-1" },
			status: 200,
		}),
		"POST /v1/jobs": (options) => {
			seen.startAuth.push(authOf(options))
			return { body: { id: "job_1" }, status: 202 }
		},
	}
	const respond: Responder = (method, path, options) => routes[`${method} ${path}`]?.(options)
	return { ...seen, respond }
}

/* A client acting as alpha, whose bearer comes from `recipe`, on a clock the test moves. */
function signedIn(respond: Responder, recipe: Recipe) {
	const clock = { now: Date.now() }
	const client = actingClient({
		fetchImpl: transport(respond).fetch,
		model,
		now: () => clock.now,
		principals: { alpha: {} },
		security: { bearer: recipe },
	})
	return { client, clock }
}

const POLL_JOB = {
	idFrom: "$.id",
	poll: "GET /v1/jobs/{id}",
	pollIntervalMs: 1,
	successWhen: "status.eq.done",
	timeoutMs: 1_000,
	until: "status.eq.done",
}

async function renewsAfterLapse(): Promise<void> {
	const { pollAuth, refreshHits, respond } = jobs(90)
	const { client, clock } = signedIn(respond, signup)
	const start = await client.request("POST", "/v1/jobs", { as: { principal: "alpha" } })
	expect(start.status).toBe(202)
	expect(start.principal).toBe("alpha")
	expect(refreshHits).toEqual([])
	/* The POST itself outlived the token's life. The next dispatch, the first poll, must renew it. */
	clock.now += 91_000
	const outcome = await driveAsync({
		client,
		principal: "alpha",
		receipt: start.responseBody,
		scope: {},
		spec: POLL_JOB,
		start,
	})
	expect(outcome.succeeded).toBe(true)
	expect(refreshHits).toEqual(["rt-1"])
	expect(pollAuth).toEqual(["Bearer t2", "Bearer t2"])
}

async function renewsInsideBuffer(): Promise<void> {
	const { pollAuth, refreshHits, respond, startAuth } = jobs(90)
	const { client, clock } = signedIn(respond, signup)
	const start = await client.request("POST", "/v1/jobs", { as: { principal: "alpha" } })
	/* Still valid for 25 s, inside the 30 s buffer: the next request renews it rather than risk it. */
	clock.now += 65_000
	const outcome = await driveAsync({
		client,
		principal: "alpha",
		receipt: start.responseBody,
		scope: {},
		spec: POLL_JOB,
		start,
	})
	expect(outcome.succeeded).toBe(true)
	expect(startAuth).toEqual(["Bearer t1"])
	expect(refreshHits).toEqual(["rt-1"])
	expect(pollAuth).toEqual(["Bearer t2", "Bearer t2"])
}

/* Signs up once; the sign-in that would renew the lapsed token is refused. */
function refusingRenewal() {
	const seen = { pollAuth: [] as string[], signUps: 0, startAuth: [] as string[] }
	const respond: Responder = (_method, path, options) => {
		if (path === "/v1/auth/register") {
			seen.signUps += 1
			if (seen.signUps > 1) return { body: { error: "down" }, status: 500 }
			return { body: { access_token: "t1", access_token_expires_in: 90, refresh_token: "rt-1" }, status: 200 }
		}
		if (path === "/v1/jobs") {
			seen.startAuth.push(authOf(options))
			return { body: { id: "job_1" }, status: 202 }
		}
		seen.pollAuth.push(authOf(options))
		return { body: { status: "running" }, status: 200 }
	}
	return { respond, seen }
}

async function stopsOnFailedRenewal(): Promise<void> {
	const { respond, seen } = refusingRenewal()
	const { refresh: _refresh, ...noRefresh } = signup
	const { client, clock } = signedIn(respond, noRefresh as Recipe)
	const start = await client.request("POST", "/v1/jobs", { as: { principal: "alpha" } })
	expect(seen.startAuth).toEqual(["Bearer t1"])
	clock.now += 91_000
	const polling = driveAsync({
		client,
		principal: "alpha",
		receipt: start.responseBody,
		scope: {},
		spec: { idFrom: "$.id", poll: "GET /v1/jobs/{id}", pollIntervalMs: 1, timeoutMs: 200, until: "status.eq.done" },
		start,
	})
	await expect(polling).rejects.toBeInstanceOf(UnsatisfiedSecurity)
	await expect(polling).rejects.toMatchObject({ kind: "blocked" })
	expect(seen.signUps).toBe(2)
	expect(seen.pollAuth).toEqual([])
}

describe("polling a job as a principal", () => {
	it("renews a credential the start outlived before the first poll sends it", renewsAfterLapse)
	it("renews a credential inside its refresh buffer once, before it lapses", renewsInsideBuffer)
	it("stops polling when renewing a lapsed credential fails, rather than send the dead one", stopsOnFailedRenewal)
})
