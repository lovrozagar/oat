import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createPrincipal, resolveOutOfBandValue } from "../src/runtime/auth.ts"
import { Client } from "../src/runtime/client.ts"
import { run } from "../src/runtime/run.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { report } from "../src/report/console.ts"
import { readInvite } from "../src/spec/extensions.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

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

const SPEC = {
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
} as OpenApiDocument

const model = buildModel(dereference(SPEC).doc)

describe("absolute URL RequestStep + cookie saveAs", () => {
	it("GETs a foreign origin, follows a 303, and binds Set-Cookie from the redirect", async () => {
		const session = unsignedJwt({ orgs: [{ oid: "org_1", pids: ["proj_1"] }] })
		const seen: string[] = []
		const app = await listen((req, res) => {
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
				expect(req.headers.cookie).toContain("session=")
				return send(res, 200, { ok: true })
			}
			return send(res, 404)
		})
		closers.push(app.close)

		const api = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/v1/auth/register") {
				return send(res, 200, { access_token: unsignedJwt({ sub: "u1" }), refresh_token: "rt-1" })
			}
			return send(res, 404)
		})
		closers.push(api.close)

		let oob:
			| { address: string; kind: string; scope: Record<string, string>; headers: Record<string, string> }
			| undefined
		const client = new Client(api.url)
		const runtime = await createPrincipal(
			"alpha",
			{
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
			},
			{
				client,
				hooks: {
					resolveOutOfBand: async (request) => {
						oob = request
						return `${app.url}/verify?token=mailed`
					},
				},
				model,
				principalId: "alpha",
			},
		)

		expect(oob?.address).toBe("a@x.test")
		expect(oob?.kind).toBe("email-verify")
		expect(oob?.scope.credential).toBeDefined()
		expect(oob?.headers.cookie).toMatch(/^session=/)
		expect(seen).toEqual(["GET /verify", "GET /app"])
		expect(runtime.headers().cookie).toBe(`session=${session}`)
		expect(runtime.scope.refreshToken).toBe("rt-cookie")
		expect(runtime.scope.orgId).toBe("org_1")
		expect(runtime.scope.projectId).toBe("proj_1")
		expect(runtime.address).toBe("a@x.test")
		expect(runtime.credential()).toBe(session)

		const consume = client.transcript.find((e) => e.url.includes("/verify"))
		expect(consume).toBeDefined()
		expect(consume?.method).toBe("GET")
		expect(consume?.status).toBe(200)
		expect(consume?.url).toContain(app.url)
		expect(consume?.url).not.toContain(api.url)
		expect(consume?.redirects).toHaveLength(1)
		expect(consume?.redirects?.[0]?.status).toBe(303)
		expect(consume?.finalUrl).toContain("/app")
		expect(consume?.cookies?.session).toBe(session)
	})

	it("stops at the 303 when redirect is manual and still binds that Set-Cookie", async () => {
		const session = unsignedJwt({ sub: "u" })
		const app = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/verify") {
				res.writeHead(303, { location: "/login", "set-cookie": `session=${session}; Path=/` })
				res.end()
				return
			}
			return send(res, 404, { error: "followed" })
		})
		closers.push(app.close)
		const api = await listen((req, res) => {
			if ((req.url ?? "").startsWith("/v1/auth/register")) return send(res, 200, { access_token: "reg" })
			return send(res, 404)
		})
		closers.push(api.close)

		const client = new Client(api.url)
		const runtime = await createPrincipal(
			"alpha",
			{
				credentialFrom: "$.access_token",
				steps: [
					{ method: "POST", path: "/v1/auth/register", saveAs: { credential: "$.access_token" } },
					{ outOfBand: { address: "a@x.test", as: "verifyLink", kind: "email-verify" } },
					{
						expect: [303],
						method: "GET",
						path: "{verifyLink}",
						redirect: "manual",
						saveAs: { credential: "cookie:session" },
					},
				],
			},
			{
				client,
				hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
				model,
				principalId: "alpha",
			},
		)
		expect(runtime.credential()).toBe(session)
		const consume = client.transcript.find((e) => e.url.includes("/verify"))
		expect(consume?.status).toBe(303)
		expect(consume?.redirects).toBeUndefined()
		expect(consume?.cookies?.session).toBe(session)
	})

	it("interpolates scope into a saveAs address (per-user cookie names)", async () => {
		const app = await listen((_req, res) => {
			res.writeHead(200, { "set-cookie": ["rt.u42=rt-u42; Path=/", "rt.u7=rt-u7; Path=/"] })
			res.end()
		})
		closers.push(app.close)
		const api = await listen((req, res) => {
			if ((req.url ?? "").startsWith("/v1/auth/register")) {
				return send(res, 200, { access_token: unsignedJwt({ sub: "u42" }) })
			}
			return send(res, 404)
		})
		closers.push(api.close)

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
				client: new Client(api.url),
				hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
				model,
				principalId: "alpha",
			},
		)
		expect(runtime.scope.refreshToken).toBe("rt-u42")
	})

	it("fails closed when the named cookie is missing", async () => {
		const app = await listen((_req, res) => send(res, 200, { ok: true }))
		closers.push(app.close)
		const api = await listen((req, res) => {
			if ((req.url ?? "").startsWith("/v1/auth/register")) return send(res, 200, { access_token: "reg" })
			return send(res, 404)
		})
		closers.push(api.close)
		const client = new Client(api.url)
		await expect(
			createPrincipal(
				"alpha",
				{
					credentialFrom: "$.access_token",
					steps: [
						{ method: "POST", path: "/v1/auth/register", saveAs: { credential: "$.access_token" } },
						{ outOfBand: { address: "a@x.test", as: "link", kind: "email-verify" } },
						{
							method: "GET",
							path: "{link}",
							saveAs: { credential: "cookie:session" },
						},
					],
				},
				{
					client,
					hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
					model,
					principalId: "alpha",
				},
			),
		).rejects.toThrow(/saveAs\.credential = "cookie:session"/)
	})

	it("binds a non-set-cookie response header and fails on a missing header", async () => {
		const app = await listen((_req, res) => {
			res.writeHead(200, { "x-session": "hdr-tok", "content-type": "text/plain" })
			res.end("ok")
		})
		closers.push(app.close)
		const api = await listen((req, res) => {
			if ((req.url ?? "").startsWith("/v1/auth/register")) return send(res, 200, { access_token: "reg" })
			return send(res, 404)
		})
		closers.push(api.close)
		const client = new Client(api.url)
		const runtime = await createPrincipal(
			"alpha",
			{
				credentialFrom: "$.access_token",
				steps: [
					{ method: "POST", path: "/v1/auth/register", saveAs: { credential: "$.access_token" } },
					{ outOfBand: { address: "a@x.test", as: "link", kind: "email-verify" } },
					{ method: "GET", path: "{link}", saveAs: { credential: "header:x-session" } },
				],
			},
			{
				client,
				hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
				model,
				principalId: "alpha",
			},
		)
		expect(runtime.credential()).toBe("hdr-tok")

		await expect(
			createPrincipal(
				"beta",
				{
					credentialFrom: "$.access_token",
					steps: [
						{ method: "POST", path: "/v1/auth/register", saveAs: { credential: "$.access_token" } },
						{ outOfBand: { address: "b@x.test", as: "link", kind: "email-verify" } },
						{ method: "GET", path: "{link}", saveAs: { credential: "header:x-missing" } },
					],
				},
				{
					client: new Client(api.url),
					hooks: { resolveOutOfBand: async () => `${app.url}/verify` },
					model,
					principalId: "beta",
				},
			),
		).rejects.toThrow(/header:x-missing/)
	})

	it("keeps JSON-path saveAs and saveClaimsFrom.token into the body", async () => {
		const token = unsignedJwt({ orgs: [{ oid: "org_z" }] })
		const api = await listen((req, res) => {
			if ((req.url ?? "").startsWith("/v1/auth/register")) {
				return send(res, 200, { access_token: token })
			}
			return send(res, 404)
		})
		closers.push(api.close)
		const client = new Client(api.url)
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
			{ client, hooks: {}, model, principalId: "alpha" },
		)
		expect(runtime.scope.orgId).toBe("org_z")
		expect(runtime.credential()).toBe(token)
	})
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

describe("teardownPrincipal ctx", () => {
	it("calls the hook with the last live credential headers", async () => {
		const token = unsignedJwt({ sub: "u" })
		const spec = {
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
		const called: Array<{ address: string; credential: string; headers: Record<string, string> }> = []
		const oneArg: string[] = []
		const server = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi") return send(res, 200, spec)
			if (url.pathname === "/v1/auth/register") return send(res, 200, { access_token: token })
			if (url.pathname === "/v1/notes") return send(res, 200, { notes: [] })
			return send(res, 404)
		})
		closers.push(server.close)

		await run({
			baseUrl: server.url,
			hooks: {
				teardownPrincipal: async (address, ctx) => {
					called.push({ address, credential: ctx.credential, headers: ctx.headers })
				},
			},
			only: ["note"],
			principals: [
				{
					auth: {
						credentialFrom: "$.access_token",
						steps: [{ bind: { address: "a@x.test" }, method: "POST", path: "/v1/auth/register" }],
					},
					id: "alpha",
				},
			],
			seed: 1,
			spec: `${server.url}/openapi`,
		})
		expect(called).toHaveLength(1)
		expect(called[0]?.address).toBe("a@x.test")
		expect(called[0]?.credential).toBe(token)
		expect(called[0]?.headers.authorization).toBe(`Bearer ${token}`)

		await run({
			baseUrl: server.url,
			hooks: {
				teardownPrincipal: async (address: string) => {
					oneArg.push(address)
				},
			},
			only: ["note"],
			principals: [
				{
					auth: {
						credentialFrom: "$.access_token",
						steps: [{ bind: { address: "b@x.test" }, method: "POST", path: "/v1/auth/register" }],
					},
					id: "alpha",
				},
			],
			seed: 1,
			spec: `${server.url}/openapi`,
		})
		expect(oneArg).toEqual(["b@x.test"])
	})
})

describe("readInvite acceptFrom", () => {
	it("defaults to token and records link when tagged", () => {
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBeUndefined()
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", acceptFrom: "link", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBe("link")
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", acceptFrom: "token", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBeUndefined()
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", acceptFrom: "nope", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBeUndefined()
	})
})

describe("doctor / plan invite accept mode", () => {
	it("prints JSON-token and GET-link", () => {
		const doc = {
			info: { title: "inv", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/orgs/{org_id}/members": {
					get: {
						operationId: "member.list",
						parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: { properties: { members: { type: "array" } }, type: "object" },
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "list", identity: "id", name: "member" },
					},
					post: {
						operationId: "org.inviteMember",
						parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
						responses: { "201": { description: "ok" } },
						"x-entity": { action: "create", identity: "id", name: "member" },
						"x-invite": {
							accept: "invite.accept",
							acceptFrom: "link",
							invite: "org.inviteMember",
							revoke: "invite.revoke",
							tokenFrom: "outOfBand",
						},
					},
				},
				"/v1/invites/accept": {
					post: {
						operationId: "invite.accept",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "action", identity: "id", name: "member" },
					},
				},
				"/v1/invites/revoke": {
					post: {
						operationId: "invite.revoke",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "action", identity: "id", name: "member" },
					},
				},
			},
		} as OpenApiDocument
		const modelled = buildModel(dereference(doc).doc)
		const plan = report.plan(modelled, false)
		const doctor = report.doctor(modelled, [], false)
		expect(plan).toContain("GET-link")
		expect(plan).toContain("acceptFrom: link")
		expect(doctor.text).toContain("GET-link")
		const asJson = JSON.parse(report.doctor(modelled, [], true).text) as { invites: Array<{ acceptFrom: string }> }
		expect(asJson.invites.some((row) => row.acceptFrom === "link")).toBe(true)
		expect(report.plan(modelled, true)).toContain("acceptFrom")
	})
})
