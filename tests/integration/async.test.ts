import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../src/client/credential-source.ts"
import type { Recipe } from "../../src/config/types/security.ts"
import { driveAsync } from "../../src/runtime/async.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { actingClient } from "../support/acting-client.ts"

/*
 * A job outlives the credential it started with. Every poll resolves alpha's credential afresh from
 * the store, so a lapsed one is renewed before a poll would send it, and a renewal that fails stops
 * the poll instead of sending the dead token.
 */

const SPEC = {
	components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
	info: { title: "async-refresh", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/auth/register": {
			post: {
				operationId: "auth.register",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
				security: [],
			},
		},
		"/v1/auth/refresh": {
			post: {
				operationId: "auth.refreshToken",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
				security: [],
			},
		},
		"/v1/jobs": {
			post: {
				operationId: "job.start",
				responses: { "202": { description: "accepted" } },
			},
		},
		"/v1/jobs/{id}": {
			get: {
				operationId: "job.poll",
				responses: { "200": { description: "ok" } },
			},
		},
	},
	security: [{ bearer: [] }],
} as OpenApiDocument

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			if (text === "") {
				resolve(undefined)
				return
			}
			try {
				resolve(JSON.parse(text) as unknown)
			} catch (error) {
				reject(error)
			}
		})
		req.on("error", reject)
	})
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	close: () => Promise<void>
	url: string
}> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

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

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

/*
 * A backend whose sign-up token lives `expiresIn` seconds and whose refresh issues t2; job_1 is
 * accepted on POST and reads done from its second poll on.
 */
async function serveJobs(expiresIn: number) {
	const seen = { pollAuth: [] as string[], refreshHits: [] as string[], startAuth: [] as string[] }
	let polls = 0
	const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void> = {
		"GET /v1/jobs/job_1": (req, res) => {
			seen.pollAuth.push(req.headers.authorization ?? "")
			polls += 1
			return send(res, 200, { status: polls >= 2 ? "done" : "running" })
		},
		"POST /v1/auth/refresh": async (req, res) => {
			const body = (await readJson(req)) as { refresh_token?: string }
			seen.refreshHits.push(body.refresh_token ?? "")
			return send(res, 200, { access_token: "t2", access_token_expires_in: 90, refresh_token: "rt-2" })
		},
		"POST /v1/auth/register": (_req, res) =>
			send(res, 200, { access_token: "t1", access_token_expires_in: expiresIn, refresh_token: "rt-1" }),
		"POST /v1/jobs": (req, res) => {
			seen.startAuth.push(req.headers.authorization ?? "")
			return send(res, 202, { id: "job_1" })
		},
	}
	const server = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const route = routes[`${(req.method ?? "GET").toUpperCase()} ${url.pathname}`]
		if (route === undefined) return send(res, 404)
		void route(req, res)
	})
	closers.push(server.close)
	return { ...seen, url: server.url }
}

/* A client on `url` acting as alpha, whose bearer comes from `recipe`, on a clock the test moves. */
function signedIn(url: string, recipe: Recipe) {
	const clock = { now: Date.now() }
	const client = actingClient({
		baseUrl: url,
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
	const { pollAuth, refreshHits, url } = await serveJobs(90)
	const { client, clock } = signedIn(url, signup)

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
	const { pollAuth, refreshHits, startAuth, url } = await serveJobs(90)
	const { client, clock } = signedIn(url, signup)

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

async function stopsOnFailedRenewal(): Promise<void> {
	const pollAuth: string[] = []
	const startAuth: string[] = []
	let signUps = 0
	const server = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		/* Signs up once; the sign-in that would renew the lapsed token is refused. */
		if (url.pathname === "/v1/auth/register") {
			signUps += 1
			if (signUps > 1) return send(res, 500, { error: "down" })
			return send(res, 200, { access_token: "t1", access_token_expires_in: 90, refresh_token: "rt-1" })
		}
		if (url.pathname === "/v1/jobs") {
			startAuth.push(req.headers.authorization ?? "")
			return send(res, 202, { id: "job_1" })
		}
		pollAuth.push(req.headers.authorization ?? "")
		return send(res, 200, { status: "running" })
	})
	closers.push(server.close)

	const { refresh: _refresh, ...noRefresh } = signup
	const { client, clock } = signedIn(server.url, noRefresh as Recipe)
	const start = await client.request("POST", "/v1/jobs", { as: { principal: "alpha" } })
	expect(startAuth).toEqual(["Bearer t1"])
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
	expect(signUps).toBe(2)
	expect(pollAuth).toEqual([])
}

describe("polling a job as a principal", () => {
	it("renews a credential the start outlived before the first poll sends it", renewsAfterLapse)
	it("renews a credential inside its refresh buffer once, before it lapses", renewsInsideBuffer)
	it("stops polling when renewing a lapsed credential fails, rather than send the dead one", stopsOnFailedRenewal)
})
