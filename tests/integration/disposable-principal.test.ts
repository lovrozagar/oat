import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { text } from "node:stream/consumers"
import { afterEach, describe, expect, it } from "vitest"
import { bearerSecurity } from "../../src/conformance/harness/security.ts"
import type { SecurityConfig } from "../../src/config/types/security.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import { jsonBody } from "../support/json-body.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

const PROFILE = {
	properties: { first_name: { type: "string" } },
	required: ["first_name"],
	type: "object",
}

function profilePaths(): Record<string, unknown> {
	return {
		"/v1/me": {
			get: {
				operationId: "profile.read",
				responses: {
					"200": { content: { "application/json": { schema: PROFILE } }, description: "ok" },
					"401": { description: "unauthorized" },
				},
				"x-entity": { action: "read", identity: "self", name: "profile" },
			},
			patch: {
				operationId: "profile.update",
				requestBody: {
					content: { "application/json": { schema: PROFILE } },
					required: true,
				},
				responses: {
					"200": { content: { "application/json": { schema: PROFILE } }, description: "ok" },
					"401": { description: "unauthorized" },
				},
				"x-entity": { action: "update", identity: "self", name: "profile" },
			},
		},
	}
}

function registerPath(): Record<string, unknown> {
	return {
		post: {
			operationId: "auth.register",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							properties: { email: { format: "email", type: "string" } },
							required: ["email"],
							type: "object",
						},
					},
				},
				required: true,
			},
			responses: {
				"201": {
					content: {
						"application/json": {
							schema: {
								properties: { access_token: { type: "string" } },
								required: ["access_token"],
								type: "object",
							},
						},
					},
					description: "created",
				},
			},
			security: [],
			"x-fresh-principal": true,
		},
	}
}

function spec(): OpenApiDocument {
	return {
		...bearerSecurity(),
		info: { title: "disposable", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/logout": {
				post: {
					operationId: "auth.logout",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" },
								},
							},
							description: "ok",
						},
						"401": { description: "unauthorized" },
					},
					"x-destructive": true,
					"x-invalidate": ["GET /v1/me"],
				},
			},
			...profilePaths(),
			"/v1/passkeys/register/options": {
				post: {
					operationId: "auth.passkeyRegisterOptions",
					responses: {
						"200": { description: "ok" },
						"401": { description: "unauthorized" },
					},
				},
			},
			"/v1/register": registerPath(),
		},
	} as OpenApiDocument
}

interface Hit {
	body: Record<string, unknown>
	method: string
	path: string
	token: string
}

/** A JSON answer; without a body the response is a bare status. */
interface Reply {
	body?: unknown
	status: number
}

type Route = (hit: Hit) => Reply | undefined

const UNAUTHORIZED: Reply = { body: { error: "unauthorized" }, status: 401 }

function write(res: ServerResponse, reply: Reply): void {
	if (reply.body === undefined) {
		res.writeHead(reply.status)
		res.end()
		return
	}
	res.writeHead(reply.status, { "content-type": "application/json" })
	res.end(JSON.stringify(reply.body))
}

async function readHit(req: IncomingMessage, url: URL, method: string): Promise<Hit | undefined> {
	const body = jsonBody(await text(req))
	const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
	return body === undefined ? undefined : { body, method, path: url.pathname, token }
}

/** Serves `document` at /openapi.json and answers every other request by the first route that does, else `notFound`. */
async function listenRoutes(document: OpenApiDocument, routes: Route[], notFound: Reply): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") return write(res, { body: document, status: 200 })
			const hit = await readHit(req, url, method)
			if (hit === undefined) return write(res, { body: { error: "malformed json" }, status: 400 })
			for (const route of routes) {
				const reply = route(hit)
				if (reply !== undefined) return write(res, reply)
			}
			write(res, notFound)
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

/** GET and PATCH /v1/me for a token `names` knows; any other token is refused. */
function profileRoute(names: Map<string, string>): Route {
	return ({ body, method, path, token }) => {
		if (path !== "/v1/me" || (method !== "GET" && method !== "PATCH")) return undefined
		if (!names.has(token)) return UNAUTHORIZED
		if (method === "PATCH" && typeof body["first_name"] === "string") names.set(token, body["first_name"])
		return { body: { first_name: names.get(token) }, status: 200 }
	}
}

/** Registers a fresh `disp-<n>` session; `refresh` also issues its refresh token. */
function disposableRegister(names: Map<string, string>, refresh: boolean): Route {
	return ({ method, path }) => {
		if (path !== "/v1/register" || method !== "POST") return undefined
		const tokenId = `disp-${names.size}`
		names.set(tokenId, "Ada")
		return {
			body: refresh ? { access_token: tokenId, refresh_token: `rf-${tokenId}` } : { access_token: tokenId },
			status: 201,
		}
	}
}

const passkeys: Route = ({ path }) => (path === "/v1/passkeys/register/options" ? UNAUTHORIZED : undefined)

async function serve(killCaller: boolean): Promise<string> {
	const names = new Map<string, string>([["alpha", "Ada"]])
	const logout: Route = ({ method, path, token }) => {
		if (path !== "/v1/logout" || method !== "POST") return undefined
		if (killCaller) names.clear()
		else names.delete(token)
		return { body: { ok: true }, status: 200 }
	}
	return listenRoutes(spec(), [passkeys, disposableRegister(names, false), logout, profileRoute(names)], {
		status: 404,
	})
}

function refreshSpec(): OpenApiDocument {
	const document = spec()
	const paths = document.paths as Record<string, Record<string, unknown>>
	const register = paths["/v1/register"]?.post as {
		responses: Record<
			string,
			{ content: { "application/json": { schema: { properties: Record<string, unknown>; required: string[] } } } }
		>
	}
	const created = register.responses["201"]?.content["application/json"].schema
	if (created === undefined) throw new Error("the register operation documents no 201 body")
	created.properties.refresh_token = { type: "string" }
	created.required.push("refresh_token")
	const logout = paths["/v1/logout"]?.post as { requestBody?: unknown }
	logout.requestBody = {
		content: {
			"application/json": {
				schema: {
					properties: { refresh_token: { type: "string" } },
					required: ["refresh_token"],
					type: "object",
				},
			},
		},
		required: true,
	}
	paths["/v1/refresh"] = {
		post: {
			operationId: "auth.refresh",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							properties: { refresh_token: { type: "string" } },
							required: ["refresh_token"],
							type: "object",
						},
					},
				},
				required: true,
			},
			responses: {
				"200": { description: "renewed" },
				"401": { description: "unauthorized" },
			},
			security: [],
		},
	}
	return document
}

async function serveRefresh(refreshLives: boolean): Promise<string> {
	const names = new Map<string, string>([["alpha", "Ada"]])
	const dead = new Set<string>()
	const logout: Route = ({ body, method, path }) => {
		if (path !== "/v1/logout" || method !== "POST") return undefined
		if (typeof body["refresh_token"] === "string") dead.add(body["refresh_token"])
		return { body: { ok: true }, status: 200 }
	}
	const refresh: Route = ({ body, method, path }) => {
		if (path !== "/v1/refresh" || method !== "POST") return undefined
		const token = body["refresh_token"]
		const alive = typeof token === "string" && !dead.has(token)
		return refreshLives || alive ? { body: { ok: true }, status: 200 } : UNAUTHORIZED
	}
	const routes = [disposableRegister(names, true), logout, refresh, profileRoute(names)]
	return listenRoutes(refreshSpec(), routes, { status: 404 })
}

/* A second user holds the token its signup answered; the suite caller, alpha, a fixed one. */
async function runDisposable(baseUrl: string) {
	return run({
		baseUrl,
		principals: { alpha: { security: { bearer: { static: "alpha" } } } },
		security: { bearer: { login: { from: "$.access_token", steps: [{ operationId: "auth.register" }] } } },
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

function withoutLogout(): OpenApiDocument {
	const document = spec()
	delete (document.paths as Record<string, unknown>)["/v1/logout"]
	return document
}

function ok(properties: Record<string, unknown>, required: string[]) {
	return {
		"200": {
			content: { "application/json": { schema: { properties, required, type: "object" } } },
			description: "ok",
		},
		"400": { description: "bad" },
		"401": { description: "unauthorized" },
		"415": { description: "type" },
	}
}

async function startServer(document: OpenApiDocument, handle: Route): Promise<string> {
	const names = new Map<string, string>([
		["alpha", "Ada"],
		["t1", "Ada"],
	])
	const register: Route = ({ method, path }) => {
		if (path !== "/v1/register" || method !== "POST") return undefined
		names.set("t1", "Ada")
		return { body: { access_token: "t1", refresh_token: "r1" }, status: 201 }
	}
	return listenRoutes(document, [register, handle, profileRoute(names)], { body: { error: "missing" }, status: 404 })
}

/* alpha signs up and renews by the refresh token its signup saved. */
const SAVE_REFRESH = { refresh_token: "$.refresh_token" }
const REFRESHING: SecurityConfig = {
	bearer: {
		login: {
			from: "$.access_token",
			steps: [{ body: { email: "suite@example.test" }, operationId: "auth.register", saveAs: SAVE_REFRESH }],
		},
		refresh: {
			from: "$.access_token",
			steps: [{ body: { refresh_token: "{refresh_token}" }, operationId: "auth.refresh" }],
		},
	},
}

/* The refresh a recipe declares — oat never guesses a refresh route by field name. */
async function runRefreshFlow(baseUrl: string) {
	return run({
		baseUrl,
		hooks: {},
		principals: { alpha: {} },
		security: REFRESHING,
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

async function logsOutSecondUser(): Promise<void> {
	const url = await serve(false)
	const result = await runDisposable(url)
	const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
	expect(defects).toEqual([])
	const logout = result.scope.operations.find((op) => op.operationId === "auth.logout")
	expect(logout?.status).toBe("passed")
	expect(logout?.tier).toBe("verified")
	const logoutAt = result.client.transcript.findIndex(
		(exchange) => exchange.method === "POST" && exchange.url.endsWith("/v1/logout"),
	)
	expect(logoutAt).toBeGreaterThanOrEqual(0)
	expect(result.client.transcript[logoutAt]?.principal).toMatch(/^disposable-/)
	const after = result.client.transcript.slice(logoutAt + 1)
	expect(
		after.some(
			(exchange) => exchange.url.endsWith("/v1/me") && exchange.principal === "alpha" && exchange.status === 200,
		),
	).toBe(true)
	const refused = result.client.transcript.find((exchange) => exchange.seq === logout?.evidence?.observation?.seq)
	expect(refused?.url.endsWith("/v1/me")).toBe(true)
	expect(refused?.status).toBe(401)
}

async function acceptsRefreshKillingLogout(): Promise<void> {
	const url = await serveRefresh(false)
	const result = await runRefreshFlow(url)
	const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
	expect(defects.map((finding) => finding.summary)).toEqual([])
	expect(result.scope.operations.find((op) => op.operationId === "auth.logout")?.status).toBe("passed")
	const logoutAt = result.client.transcript.findIndex((exchange) => exchange.url.endsWith("/v1/logout"))
	const after = result.client.transcript.slice(logoutAt + 1)
	expect(after.some((exchange) => exchange.url.endsWith("/v1/refresh") && exchange.status === 401)).toBe(true)
}

async function reportsLogoutWhoseRefreshRenews(): Promise<void> {
	const url = await serveRefresh(true)
	const result = await runRefreshFlow(url)
	const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
	expect(defects.map((finding) => finding.summary)).toContain("the disposable session was still accepted")
}

async function acceptsAccountDelete(): Promise<void> {
	const document = withoutLogout()
	const paths = document.paths as Record<string, Record<string, unknown>>
	paths["/v1/account/delete"] = {
		post: {
			operationId: "auth.deleteAccount",
			responses: ok({ ok: { type: "boolean" } }, ["ok"]),
			"x-destructive": true,
			"x-invalidate": ["GET /v1/me"],
		},
	}
	let deleted = false
	const url = await startServer(document, ({ method, path, token }) => {
		if (path === "/v1/me" && method === "GET" && token === "t1" && deleted) {
			return { body: { error_key: "not_found" }, status: 404 }
		}
		if (path === "/v1/account/delete" && method === "POST") {
			deleted = true
			return { body: { ok: true }, status: 200 }
		}
		return undefined
	})
	const result = await runDisposable(url)
	const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
	expect(defects).toEqual([])
	expect(result.scope.operations.find((op) => op.operationId === "auth.deleteAccount")?.status).toBe("passed")
}

async function reportsLogoutKillingSuiteSession(): Promise<void> {
	const url = await serve(true)
	const result = await runDisposable(url)
	const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
	expect(defects.map((finding) => finding.check)).toContain("auth.destructive-spares-the-caller")
	expect(result.scope.operations.find((op) => op.operationId === "profile.read")?.status).not.toBe("failed")
}

async function provesRemovedItem(): Promise<void> {
	const document = withoutLogout()
	const paths = document.paths as Record<string, Record<string, unknown>>
	const device = { properties: { id: { type: "string" } }, required: ["id"], type: "object" }
	paths["/v1/devices"] = {
		get: {
			operationId: "device.list",
			responses: ok({ devices: { items: device, type: "array" } }, ["devices"]),
		},
	}
	paths["/v1/devices/{id}"] = {
		delete: {
			operationId: "device.forget",
			parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
			responses: ok({ ok: { type: "boolean" } }, ["ok"]),
			"x-destructive": true,
		},
	}
	const devices = new Set(["dev_1", "dev_2"])
	const url = await startServer(document, ({ method, path }) => {
		if (path === "/v1/devices" && method === "GET") {
			return { body: { devices: [...devices].map((id) => ({ id })) }, status: 200 }
		}
		const one = /^\/v1\/devices\/([^/]+)$/.exec(path)
		if (one !== null && method === "DELETE") {
			devices.delete(one[1] ?? "")
			return { body: { ok: true }, status: 200 }
		}
		return undefined
	})
	const result = await runDisposable(url)
	const forget = result.scope.operations.find((op) => op.operationId === "device.forget")
	expect(forget?.status).toBe("passed")
	expect(forget?.tier).toBe("verified")
	expect(forget?.evidence?.observation).toMatchObject({ absent: true, value: "dev_1" })
}

async function leavesRefusedDestructiveUntested(): Promise<void> {
	const document = withoutLogout()
	const paths = document.paths as Record<string, Record<string, unknown>>
	paths["/v1/two-factor/disable"] = {
		post: {
			operationId: "auth.disable2fa",
			responses: { ...ok({ ok: { type: "boolean" } }, ["ok"]), "409": { description: "not enabled" } },
			"x-destructive": true,
		},
	}
	const url = await startServer(document, ({ path }) =>
		path === "/v1/two-factor/disable" ? { body: { error: "two_factor_not_enabled" }, status: 409 } : undefined,
	)
	const result = await runDisposable(url)
	const disable = result.scope.operations.find((op) => op.operationId === "auth.disable2fa")
	expect(disable?.status).toBe("untested")
	expect(disable?.reason).toContain("destructive call returned 409; a scenario must set the scene")
}

describe("disposable principal", () => {
	it("logs out a second registered user and leaves the suite session able to read", logsOutSecondUser)
	it("accepts a logout that kills the refresh token and leaves the access token alive", acceptsRefreshKillingLogout)
	it("reports a logout whose refresh token still renews", reportsLogoutWhoseRefreshRenews)
	it("accepts an account delete whose caller read is gone", acceptsAccountDelete)
	it("reports a logout that also kills the suite session", reportsLogoutKillingSuiteSession)
	it("proves a removed item by the list that no longer holds it", provesRemovedItem)
	it("leaves a refused destructive call untested, for a scenario to set up", leavesRefusedDestructiveUntested)
})
