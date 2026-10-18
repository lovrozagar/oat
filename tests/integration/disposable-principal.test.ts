import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { run } from "../../src/runtime/run/index.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(): OpenApiDocument {
	const profile = {
		properties: { first_name: { type: "string" } },
		required: ["first_name"],
		type: "object",
	}
	return {
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
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: {
						"200": { content: { "application/json": { schema: profile } }, description: "ok" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
				patch: {
					operationId: "profile.update",
					requestBody: {
						content: { "application/json": { schema: profile } },
						required: true,
					},
					responses: {
						"200": { content: { "application/json": { schema: profile } }, description: "ok" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "update", identity: "self", name: "profile" },
				},
			},
			"/v1/passkeys/register/options": {
				post: {
					operationId: "auth.passkeyRegisterOptions",
					responses: {
						"200": { description: "ok" },
						"401": { description: "unauthorized" },
					},
				},
			},
			"/v1/register": {
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
					"x-fresh-principal": true,
				},
			},
		},
	} as OpenApiDocument
}

async function serve(killCaller: boolean): Promise<string> {
	const document = spec()
	const names = new Map<string, string>([["alpha", "Ada"]])
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(document))
				return
			}
			const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
			if (url.pathname === "/v1/passkeys/register/options") {
				res.writeHead(401, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: "unauthorized" }))
				return
			}
			if (url.pathname === "/v1/register" && method === "POST") {
				const tokenId = `disp-${names.size}`
				names.set(tokenId, "Ada")
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ access_token: tokenId }))
				return
			}
			if (url.pathname === "/v1/logout" && method === "POST") {
				if (killCaller) names.clear()
				else names.delete(token)
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ ok: true }))
				return
			}
			if (url.pathname === "/v1/me" && (method === "GET" || method === "PATCH")) {
				if (!names.has(token)) {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (method === "PATCH") {
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { first_name?: unknown }
					if (typeof body.first_name === "string") names.set(token, body.first_name)
				}
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ first_name: names.get(token) }))
				return
			}
			res.writeHead(404)
			res.end()
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
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
		},
	}
	return document
}

async function serveRefresh(refreshLives: boolean): Promise<string> {
	const document = refreshSpec()
	const names = new Map<string, string>([["alpha", "Ada"]])
	const dead = new Set<string>()
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(document))
				return
			}
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(chunk as Buffer)
			const raw = Buffer.concat(chunks).toString("utf8")
			const body = raw === "" ? {} : (JSON.parse(raw) as { refresh_token?: unknown })
			const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
			if (url.pathname === "/v1/register" && method === "POST") {
				const tokenId = `disp-${names.size}`
				names.set(tokenId, "Ada")
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ access_token: tokenId, refresh_token: `rf-${tokenId}` }))
				return
			}
			if (url.pathname === "/v1/logout" && method === "POST") {
				if (typeof body.refresh_token === "string") dead.add(body.refresh_token)
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ ok: true }))
				return
			}
			if (url.pathname === "/v1/refresh" && method === "POST") {
				const alive = typeof body.refresh_token === "string" && !dead.has(body.refresh_token)
				const status = refreshLives || alive ? 200 : 401
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(status === 200 ? { ok: true } : { error: "unauthorized" }))
				return
			}
			if (url.pathname === "/v1/me" && (method === "GET" || method === "PATCH")) {
				if (!names.has(token)) {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (method === "PATCH" && typeof (body as { first_name?: unknown }).first_name === "string") {
					names.set(token, (body as { first_name: string }).first_name)
				}
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ first_name: names.get(token) }))
				return
			}
			res.writeHead(404)
			res.end()
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

async function runDisposable(baseUrl: string) {
	return run({
		baseUrl,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
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

async function startServer(
	document: OpenApiDocument,
	handle: (hit: {
		method: string
		path: string
		body: Record<string, unknown>
		token: string
	}) => { status: number; body: unknown } | undefined,
): Promise<string> {
	const names = new Map<string, string>([
		["alpha", "Ada"],
		["t1", "Ada"],
	])
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(document))
				return
			}
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(chunk as Buffer)
			const raw = Buffer.concat(chunks).toString("utf8")
			const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
			const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
			if (url.pathname === "/v1/register" && method === "POST") {
				names.set("t1", "Ada")
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ access_token: "t1", refresh_token: "r1" }))
				return
			}
			const hit = handle({ body, method, path: url.pathname, token })
			if (hit !== undefined) {
				res.writeHead(hit.status, { "content-type": "application/json" })
				res.end(JSON.stringify(hit.body))
				return
			}
			if (url.pathname === "/v1/me" && (method === "GET" || method === "PATCH")) {
				if (!names.has(token)) {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (method === "PATCH" && typeof body.first_name === "string") names.set(token, body.first_name)
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ first_name: names.get(token) }))
				return
			}
			res.writeHead(404, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: "missing" }))
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

/* The refresh a principal declares in its flow — oat never guesses a refresh route by field name. */
async function runRefreshFlow(baseUrl: string) {
	return run({
		baseUrl,
		hooks: {},
		principals: [
			{
				auth: {
					credentialFrom: "$.access_token",
					refresh: {
						steps: [{ body: { refresh_token: "{refreshToken}" }, operationId: "auth.refresh" }],
					},
					steps: [
						{
							body: { email: "suite@example.test" },
							operationId: "auth.register",
							saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
						},
					],
				},
				id: "alpha",
			},
		],
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

describe("disposable principal", () => {
	it("logs out a second registered user and leaves the suite session able to read", async () => {
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
		expect(result.client.transcript[logoutAt]?.requestHeaders.authorization).not.toBe("Bearer alpha")
		const after = result.client.transcript.slice(logoutAt + 1)
		expect(
			after.some(
				(exchange) =>
					exchange.url.endsWith("/v1/me") &&
					exchange.requestHeaders.authorization === "Bearer alpha" &&
					exchange.status === 200,
			),
		).toBe(true)
		const refused = result.client.transcript.find((exchange) => exchange.seq === logout?.evidence?.observation?.seq)
		expect(refused?.url.endsWith("/v1/me")).toBe(true)
		expect(refused?.status).toBe(401)
	})

	it("accepts a logout that kills the refresh token and leaves the access token alive", async () => {
		const url = await serveRefresh(false)
		const result = await runRefreshFlow(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.summary)).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.logout")?.status).toBe("passed")
		const logoutAt = result.client.transcript.findIndex((exchange) => exchange.url.endsWith("/v1/logout"))
		const after = result.client.transcript.slice(logoutAt + 1)
		expect(after.some((exchange) => exchange.url.endsWith("/v1/refresh") && exchange.status === 401)).toBe(true)
	})

	it("reports a logout whose refresh token still renews", async () => {
		const url = await serveRefresh(true)
		const result = await runRefreshFlow(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.summary)).toContain("the disposable session was still accepted")
	})

	it("accepts an account delete whose caller read is gone", async () => {
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
	})

	it("reports a logout that also kills the suite session", async () => {
		const url = await serve(true)
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.check)).toContain("auth.destructive-spares-the-caller")
		expect(result.scope.operations.find((op) => op.operationId === "profile.read")?.status).not.toBe("failed")
	})

	it("proves a removed item by the list that no longer holds it", async () => {
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
	})

	it("leaves a refused destructive call untested, for a scenario to set up", async () => {
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
	})
})
