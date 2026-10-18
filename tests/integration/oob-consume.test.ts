import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createPrincipal, resolveOutOfBandValue } from "../../src/runtime/auth.ts"
import { Client } from "../../src/client/client.ts"
import { run } from "../../src/runtime/run/index.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

type Handler = (req: IncomingMessage, res: ServerResponse) => void

interface OutOfBandSeen {
	address: string
	kind: string
	scope: Record<string, string>
	headers: Record<string, string>
}

function send(res: ServerResponse, status: number, body?: unknown, extra?: Record<string, string | string[]>): void {
	const headers: Record<string, string | string[]> = { ...extra }
	if (body === undefined) {
		res.writeHead(status, headers)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	headers["content-length"] = String(Buffer.byteLength(text))
	headers["content-type"] = "application/json"
	res.writeHead(status, headers)
	res.end(text)
}

function unsignedJwt(claims: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
	return `${header}.${payload}.sig`
}

async function listen(handler: Handler): Promise<{ close: () => Promise<void>; url: string }> {
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

/** Listens on a free port and closes after the test. */
async function serve(handler: Handler): Promise<{ url: string }> {
	const server = await listen(handler)
	closers.push(server.close)
	return server
}

/** An API that answers registration with `body` and nothing else. */
function registerApi(body: unknown): Handler {
	return (req, res) => {
		if ((req.url ?? "").startsWith("/v1/auth/register")) return send(res, 200, body)
		return send(res, 404)
	}
}

function client(url: string): Client {
	return new Client({ baseUrl: url, redactor: new Redactor() })
}

function model() {
	return buildModel(
		dereference({
			info: { title: "oob-consume", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/auth/register": {
					post: {
						operationId: "auth.register",
						requestBody: { content: { "application/json": { schema: { type: "object" } } } },
						responses: { "200": { description: "ok" } },
					},
				},
				"/v1/items": {
					get: { operationId: "item.list", responses: { "200": { description: "ok" } } },
				},
			},
		} as OpenApiDocument).doc,
	)
}

/** Registers, takes a link out of band, and consumes it with `consume` as the final GET step. */
function linkFlow(consume: Record<string, unknown>, address = "a@x.test") {
	return {
		credentialFrom: "$.access_token",
		steps: [
			{ method: "POST", path: "/v1/auth/register", saveAs: { credential: "$.access_token" } },
			{ outOfBand: { address, as: "link", kind: "email-verify" } },
			{ method: "GET", path: "{link}", ...consume },
		],
	} as Parameters<typeof createPrincipal>[1]
}

/** The app a verify link points at: 303 to /app with session cookies, then /app records the cookie it got. */
function verifyApp(session: string, seen: string[], appCookies: Array<string | undefined>): Handler {
	return (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		seen.push(`${req.method} ${url.pathname}`)
		if (url.pathname === "/verify" && req.method === "GET") {
			res.writeHead(303, {
				location: "/app",
				"set-cookie": ["session=" + session + "; Path=/; HttpOnly", "refresh=rt-cookie; Path=/"],
			})
			res.end()
			return
		}
		if (url.pathname === "/app" && req.method === "GET") {
			appCookies.push(req.headers.cookie)
			return send(res, 200, { ok: true })
		}
		return send(res, 404)
	}
}

function cookieSessionAuth() {
	return {
		credentialFrom: "$.access_token",
		header: "cookie",
		template: "session={credential}",
		steps: [
			{
				bind: { address: "a@x.test" },
				method: "POST",
				path: "/v1/auth/register",
				saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
			},
			{ outOfBand: { address: "{address}", as: "verifyLink", kind: "email-verify" } },
			{
				expect: [200, 303],
				method: "GET",
				path: "{verifyLink}",
				saveAs: { credential: "cookie:session", refreshToken: "cookie:refresh" },
				saveClaimsFrom: {
					bind: { orgId: "orgs.0.oid", projectId: "orgs.0.pids.0" },
					token: "credential",
				},
			},
		],
	} as Parameters<typeof createPrincipal>[1]
}

function expectConsumedThroughRedirect(consumer: Client, urls: { api: string; app: string }, session: string): void {
	const consume = consumer.transcript.find((e) => e.url.includes("/verify"))
	expect(consume).toBeDefined()
	expect(consume?.method).toBe("GET")
	expect(consume?.status).toBe(200)
	expect(consume?.url).toContain(urls.app)
	expect(consume?.url).not.toContain(urls.api)
	expect(consume?.redirects).toHaveLength(1)
	expect(consume?.redirects?.[0]?.status).toBe(303)
	expect(consume?.finalUrl).toContain("/app")
	expect(consume?.cookies?.session).toBe(session)
}

async function followsRedirectAndBindsCookie(): Promise<void> {
	const session = unsignedJwt({ orgs: [{ oid: "org_1", pids: ["proj_1"] }] })
	const seen: string[] = []
	const appCookies: Array<string | undefined> = []
	const app = await serve(verifyApp(session, seen, appCookies))
	const api = await serve(registerApi({ access_token: unsignedJwt({ sub: "u1" }), refresh_token: "rt-1" }))
	let oob: OutOfBandSeen | undefined
	const consumer = client(api.url)
	const runtime = await createPrincipal("alpha", cookieSessionAuth(), {
		client: consumer,
		hooks: {
			resolveOutOfBand: async (request) => {
				oob = request
				return `${app.url}/verify?token=mailed`
			},
		},
		model: model(),
		principalId: "alpha",
	})
	expect(oob?.address).toBe("a@x.test")
	expect(oob?.kind).toBe("email-verify")
	expect(oob?.scope.credential).toBeDefined()
	expect(oob?.headers.cookie).toMatch(/^session=/)
	expect(seen).toEqual(["GET /verify", "GET /app"])
	expect(appCookies).toHaveLength(1)
	expect(appCookies[0]).toContain("session=")
	expect(runtime.headers().cookie).toBe(`session=${session}`)
	expect(runtime.scope.refreshToken).toBe("rt-cookie")
	expect(runtime.scope.orgId).toBe("org_1")
	expect(runtime.scope.projectId).toBe("proj_1")
	expect(runtime.address).toBe("a@x.test")
	expect(runtime.credential()).toBe(session)
	expectConsumedThroughRedirect(consumer, { api: api.url, app: app.url }, session)
}

async function stopsAtManualRedirect(): Promise<void> {
	const session = unsignedJwt({ sub: "u" })
	const app = await serve((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/verify") {
			res.writeHead(303, { location: "/login", "set-cookie": `session=${session}; Path=/` })
			res.end()
			return
		}
		return send(res, 404, { error: "followed" })
	})
	const api = await serve(registerApi({ access_token: "reg" }))
	const consumer = client(api.url)
	const runtime = await createPrincipal(
		"alpha",
		linkFlow({ expect: [303], redirect: "manual", saveAs: { credential: "cookie:session" } }),
		{
			client: consumer,
			hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
			model: model(),
			principalId: "alpha",
		},
	)
	expect(runtime.credential()).toBe(session)
	const consume = consumer.transcript.find((e) => e.url.includes("/verify"))
	expect(consume?.status).toBe(303)
	expect(consume?.redirects).toBeUndefined()
	expect(consume?.cookies?.session).toBe(session)
}

async function interpolatesScopeIntoSaveAs(): Promise<void> {
	const app = await serve((_req, res) => {
		res.writeHead(200, { "set-cookie": ["rt.u42=rt-u42; Path=/", "rt.u7=rt-u7; Path=/"] })
		res.end()
	})
	const api = await serve(registerApi({ access_token: unsignedJwt({ sub: "u42" }) }))
	const runtime = await createPrincipal(
		"alpha",
		{
			credentialFrom: "$.access_token",
			steps: [
				{
					method: "POST",
					path: "/v1/auth/register",
					saveAs: { credential: "$.access_token" },
					saveClaimsFrom: { bind: { userId: "sub" }, token: "credential" },
				},
				{ outOfBand: { address: "a@x.test", as: "link", kind: "email-verify" } },
				{ method: "GET", path: "{link}", saveAs: { refreshToken: "cookie:rt.{userId}" } },
			],
		},
		{
			client: client(api.url),
			hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
			model: model(),
			principalId: "alpha",
		},
	)
	expect(runtime.scope.refreshToken).toBe("rt-u42")
}

async function failsClosedOnMissingCookie(): Promise<void> {
	const app = await serve((_req, res) => send(res, 200, { ok: true }))
	const api = await serve(registerApi({ access_token: "reg" }))
	await expect(
		createPrincipal("alpha", linkFlow({ saveAs: { credential: "cookie:session" } }), {
			client: client(api.url),
			hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
			model: model(),
			principalId: "alpha",
		}),
	).rejects.toThrow(/saveAs\.credential = "cookie:session"/)
}

async function bindsResponseHeader(): Promise<void> {
	const app = await serve((_req, res) => {
		res.writeHead(200, { "x-session": "hdr-tok", "content-type": "text/plain" })
		res.end("ok")
	})
	const api = await serve(registerApi({ access_token: "reg" }))
	const hooks = { resolveOutOfBand: async () => `${app.url}/verify` }
	const runtime = await createPrincipal("alpha", linkFlow({ saveAs: { credential: "header:x-session" } }), {
		client: client(api.url),
		hooks,
		model: model(),
		principalId: "alpha",
	})
	expect(runtime.credential()).toBe("hdr-tok")
	await expect(
		createPrincipal("beta", linkFlow({ saveAs: { credential: "header:x-missing" } }, "b@x.test"), {
			client: client(api.url),
			hooks,
			model: model(),
			principalId: "beta",
		}),
	).rejects.toThrow(/header:x-missing/)
}

async function keepsJsonPathSaveAs(): Promise<void> {
	const token = unsignedJwt({ orgs: [{ oid: "org_z" }] })
	const api = await serve(registerApi({ access_token: token }))
	const runtime = await createPrincipal(
		"alpha",
		{
			credentialFrom: "$.access_token",
			steps: [
				{
					method: "POST",
					path: "/v1/auth/register",
					saveAs: { credential: "$.access_token" },
					saveClaimsFrom: { bind: { orgId: "orgs.0.oid" }, token: "$.access_token" },
				},
			],
		},
		{ client: client(api.url), hooks: {}, model: model(), principalId: "alpha" },
	)
	expect(runtime.scope.orgId).toBe("org_z")
	expect(runtime.credential()).toBe(token)
}

describe("absolute URL RequestStep + cookie saveAs", () => {
	it("GETs a foreign origin, follows a 303, and binds Set-Cookie from the redirect", followsRedirectAndBindsCookie)
	it("stops at the 303 when redirect is manual and still binds that Set-Cookie", stopsAtManualRedirect)
	it("interpolates scope into a saveAs address (per-user cookie names)", interpolatesScopeIntoSaveAs)
	it("fails closed when the named cookie is missing", failsClosedOnMissingCookie)
	it("binds a non-set-cookie response header and fails on a missing header", bindsResponseHeader)
	it("keeps JSON-path saveAs and saveClaimsFrom.token into the body", keepsJsonPathSaveAs)
})

describe("resolveOutOfBand extra fields", () => {
	it("passes scope and headers into the hook", async () => {
		const seen: Array<{ scope: Record<string, string>; headers: Record<string, string> }> = []
		const value = await resolveOutOfBandValue(
			async (request) => {
				seen.push({ headers: request.headers, scope: request.scope })
				return request.attempt >= 1 ? "tok" : null
			},
			"a@x.test",
			"email-verify",
			{
				headers: { authorization: "Bearer live" },
				label: 'principal "a"',
				outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
				scope: { credential: "live", address: "a@x.test" },
			},
		)
		expect(value).toBe("tok")
		expect(seen[0]?.scope.credential).toBe("live")
		expect(seen[0]?.headers.authorization).toBe("Bearer live")
	})
})

function teardownSpec(): OpenApiDocument {
	return {
		info: { title: "teardown", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/auth/register": {
				post: {
					operationId: "auth.register",
					requestBody: { content: { "application/json": { schema: { type: "object" } } } },
					responses: { "200": { description: "ok" } },
				},
			},
			"/v1/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { notes: { items: { type: "object" }, type: "array" } },
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "note" },
				},
			},
		},
	} as OpenApiDocument
}

type TeardownPrincipal = NonNullable<NonNullable<Parameters<typeof run>[0]["hooks"]>["teardownPrincipal"]>

/** Runs the note entity as one principal registered at `address`, with `teardownPrincipal` as the hook. */
async function runRegistered(url: string, address: string, teardownPrincipal: TeardownPrincipal): Promise<void> {
	await run({
		baseUrl: url,
		hooks: { teardownPrincipal },
		only: ["note"],
		principals: [
			{
				auth: {
					credentialFrom: "$.access_token",
					steps: [{ bind: { address }, method: "POST", path: "/v1/auth/register" }],
				},
				id: "alpha",
			},
		],
		seed: 1,
		spec: `${url}/openapi`,
	})
}

async function callsTeardownWithLiveHeaders(): Promise<void> {
	const token = unsignedJwt({ sub: "u" })
	const spec = teardownSpec()
	const called: Array<{ address: string; credential: string; headers: Record<string, string> }> = []
	const oneArg: string[] = []
	const server = await serve((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname === "/openapi") return send(res, 200, spec)
		if (url.pathname === "/v1/auth/register") return send(res, 200, { access_token: token })
		if (url.pathname === "/v1/notes") return send(res, 200, { notes: [] })
		return send(res, 404)
	})
	await runRegistered(server.url, "a@x.test", async (address, ctx) => {
		called.push({ address, credential: ctx.credential, headers: ctx.headers })
	})
	expect(called).toHaveLength(1)
	expect(called[0]?.address).toBe("a@x.test")
	expect(called[0]?.credential).toBe(token)
	expect(called[0]?.headers.authorization).toBe(`Bearer ${token}`)
	await runRegistered(server.url, "b@x.test", async (address: string) => {
		oneArg.push(address)
	})
	expect(oneArg).toEqual(["b@x.test"])
}

describe("teardownPrincipal ctx", () => {
	it("calls the hook with the last live credential headers", callsTeardownWithLiveHeaders)
})
