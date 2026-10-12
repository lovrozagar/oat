import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { disposableAddress, freshSignupFlow, totpCode } from "../src/runtime/disposable.ts"
import { run } from "../src/runtime/run.ts"

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

function passwordSpec(): OpenApiDocument {
	const document = spec()
	const paths = document.paths as Record<string, Record<string, unknown>>
	delete paths["/v1/logout"]
	const json = (required: string[]) => ({
		content: {
			"application/json": {
				schema: {
					properties: Object.fromEntries(required.map((name) => [name, { type: "string" }])),
					required,
					type: "object",
				},
			},
		},
		required: true,
	})
	paths["/v1/reauth"] = {
		post: {
			operationId: "auth.reauthenticate",
			requestBody: json(["password"]),
			responses: { "200": { description: "ok" }, "401": { description: "unauthorized" } },
		},
	}
	paths["/v1/password/change"] = {
		post: {
			operationId: "auth.changePassword",
			requestBody: json(["current_password", "new_password"]),
			responses: { "200": { description: "ok" }, "401": { description: "unauthorized" } },
			"x-destructive": true,
		},
	}
	paths["/v1/password/set"] = {
		post: {
			operationId: "auth.setPassword",
			requestBody: json(["password"]),
			responses: {
				"200": { description: "ok" },
				"401": { description: "unauthorized" },
				"403": { description: "reauth" },
			},
			"x-destructive": true,
		},
	}
	return document
}

async function servePasswordRotation(): Promise<string> {
	const document = passwordSpec()
	const names = new Map<string, string>([
		["alpha", "Ada"],
		["t1", "Ada"],
	])
	let live = "t1"
	const stamped = new Set<string>()
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
			const send = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(payload))
			}
			if (url.pathname === "/v1/register" && method === "POST") {
				names.set("t1", "Ada")
				send(201, {
					access_token: "t1",
					current_password: "secret",
					new_password: "secret2",
					password: "secret",
					refresh_token: "r1",
				})
				return
			}
			if (url.pathname === "/v1/me" && method === "GET") {
				if (!names.has(token)) return send(401, { error: "unauthorized" })
				send(200, { first_name: names.get(token) })
				return
			}
			if (url.pathname === "/v1/me" && method === "PATCH") {
				if (!names.has(token)) return send(401, { error: "unauthorized" })
				if (typeof body.first_name === "string") names.set(token, body.first_name)
				send(200, { first_name: names.get(token) })
				return
			}
			if (url.pathname === "/v1/reauth" && method === "POST") {
				if (token !== live) return send(401, { error: "unauthorized" })
				stamped.add(token)
				send(200, { reauthenticated_until: Date.now() + 600_000 })
				return
			}
			if (url.pathname === "/v1/password/change" && method === "POST") {
				if (token !== live) return send(401, { error: "unauthorized" })
				live = "t2"
				names.set("t2", "Ada")
				stamped.delete("t1")
				send(200, { access_token: "t2", refresh_token: "r2" })
				return
			}
			if (url.pathname === "/v1/logout" && method === "POST") {
				send(200, { ok: true })
				return
			}
			if (url.pathname === "/v1/password/set" && method === "POST") {
				if (token !== live || !stamped.has(token)) return send(403, { error: "reauth" })
				send(200, { ok: true })
				return
			}
			send(404, { error: "missing" })
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

function requestBody(required: string[], properties?: Record<string, unknown>) {
	return {
		content: {
			"application/json": {
				schema: {
					properties: {
						...Object.fromEntries(required.map((name) => [name, { type: "string" }])),
						...properties,
					},
					required,
					type: "object",
				},
			},
		},
		required: true,
	}
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
	handle: (hit: { method: string; path: string; body: Record<string, unknown>; token: string }) =>
		| { status: number; body: unknown }
		| undefined,
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
			const hit = handle({ body, method, path: url.pathname, token })
			if (hit === undefined) {
				res.writeHead(404, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: "missing" }))
				return
			}
			res.writeHead(hit.status, { "content-type": "application/json" })
			res.end(JSON.stringify(hit.body))
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

function secondFactorSpec(): OpenApiDocument {
	const document = withoutLogout()
	const paths = document.paths as Record<string, Record<string, unknown>>
	paths["/v1/totp"] = {
		post: {
			operationId: "test.harvestTotp",
			requestBody: requestBody(["run_id", "secret"]),
			responses: ok({ code: { type: "string" } }, ["code"]),
		},
	}
	paths["/v1/two-factor/setup"] = {
		post: {
			operationId: "auth.setup2fa",
			responses: ok(
				{ otpauth_uri: { type: "string" }, qr_code: { type: "string" }, secret: { type: "string" } },
				["otpauth_uri", "qr_code", "secret"],
			),
			"x-destructive": true,
		},
	}
	paths["/v1/two-factor/enable"] = {
		post: {
			operationId: "auth.enable2fa",
			requestBody: requestBody(["code"]),
			responses: ok({ backup_codes: { items: { type: "string" }, type: "array" }, enabled: { type: "boolean" } }, ["enabled"]),
			"x-destructive": true,
		},
	}
	paths["/v1/two-factor/backup-codes"] = {
		post: {
			operationId: "auth.regenerateBackupCodes",
			requestBody: requestBody(["code"]),
			responses: ok({ backup_codes: { items: { type: "string" }, type: "array" } }, ["backup_codes"]),
			"x-destructive": true,
		},
	}
	paths["/v1/two-factor/disable"] = {
		post: {
			operationId: "auth.disable2fa",
			responses: ok({ disabled: { type: "boolean" } }, ["disabled"]),
			"x-destructive": true,
		},
	}
	return document
}

async function serveSecondFactor(): Promise<string> {
	let enabled = false
	let n = 0
	return startServer(secondFactorSpec(), ({ method, path, body }) => {
		if (path === "/v1/two-factor/setup" && method === "POST") {
			return { body: { otpauth_uri: "otpauth://totp/a?period=30", qr_code: "qr", secret: "SHHH" }, status: 200 }
		}
		if (path === "/v1/totp" && method === "POST") {
			return { body: { code: String(100000 + n++) }, status: 200 }
		}
		if (path === "/v1/two-factor/enable" && method === "POST") {
			if (typeof body.code !== "string") return { body: { error_key: "unsupported_media_type" }, status: 415 }
			enabled = true
			return { body: { backup_codes: ["BACKUP-1"], enabled: true }, status: 200 }
		}
		if (path === "/v1/two-factor/backup-codes" && method === "POST") {
			if (!enabled) return { body: { error_key: "two_factor_not_enabled" }, status: 400 }
			if (typeof body.code !== "string") return { body: { error_key: "unsupported_media_type" }, status: 415 }
			return { body: { backup_codes: ["BACKUP-2"] }, status: 200 }
		}
		if (path === "/v1/two-factor/disable" && method === "POST") {
			if (!enabled) return { body: { error_key: "two_factor_not_enabled" }, status: 400 }
			enabled = false
			return { body: { disabled: true }, status: 200 }
		}
		return undefined
	})
}

function sessionSpec(): OpenApiDocument {
	const document = withoutLogout()
	const paths = document.paths as Record<string, Record<string, unknown>>
	const register = paths["/v1/register"]?.post as { requestBody: unknown }
	register.requestBody = requestBody(["email", "password"])
	paths["/v1/login"] = {
		post: {
			operationId: "auth.login",
			requestBody: requestBody(["email", "password"]),
			responses: ok({ access_token: { type: "string" } }, ["access_token"]),
		},
	}
	paths["/v1/sessions"] = {
		get: {
			operationId: "auth.listSessions",
			responses: ok(
				{
					sessions: {
						items: { properties: { current: { type: "boolean" }, id: { type: "string" } }, type: "object" },
						type: "array",
					},
				},
				["sessions"],
			),
		},
	}
	paths["/v1/sessions/revoke"] = {
		post: {
			operationId: "auth.revokeSession",
			requestBody: requestBody(["family_id"]),
			responses: ok({ ok: { type: "boolean" } }, ["ok"]),
			"x-destructive": true,
		},
	}
	return document
}

async function serveSessions(): Promise<string> {
	let opened = false
	return startServer(sessionSpec(), ({ method, path, body, token }) => {
		if (path === "/v1/login" && method === "POST") {
			opened = true
			return { body: { access_token: "other-token" }, status: 200 }
		}
		if (path === "/v1/sessions" && method === "GET") {
			const sessions = [{ current: true, id: "fam-live" }]
			if (opened) sessions.push({ current: false, id: "fam-other" })
			return { body: { sessions }, status: 200 }
		}
		if (path === "/v1/sessions/revoke" && method === "POST") {
			if (body.family_id !== "fam-other" || token !== "t1") return { body: { error_key: "unsupported_media_type" }, status: 415 }
			return { body: { ok: true }, status: 200 }
		}
		return undefined
	})
}

function passwordlessSpec(): OpenApiDocument {
	const document = withoutLogout()
	const paths = document.paths as Record<string, Record<string, unknown>>
	const register = paths["/v1/register"]?.post as { requestBody: unknown }
	register.requestBody = requestBody(["email", "password"])
	paths["/v1/login/magic-link"] = {
		post: {
			operationId: "auth.loginMagicLink",
			requestBody: requestBody(["email"]),
			responses: ok({ success: { type: "boolean" } }, ["success"]),
		},
	}
	paths["/v1/login/magic-link/verify"] = {
		post: {
			operationId: "auth.loginMagicLinkVerify",
			requestBody: requestBody(["token"]),
			responses: ok({ access_token: { type: "string" } }, ["access_token"]),
		},
	}
	paths["/v1/reauth/code"] = {
		post: {
			operationId: "auth.requestReauthCode",
			responses: ok({ success: { type: "boolean" } }, ["success"]),
			summary: "Email a security code that confirms it's you",
		},
	}
	paths["/v1/reauth"] = {
		post: {
			operationId: "auth.reauthenticate",
			requestBody: requestBody(["password"], { email_code: { type: "string" } }),
			responses: ok({ reauthenticated_until: { type: "number" } }, ["reauthenticated_until"]),
		},
	}
	paths["/v1/password/set"] = {
		post: {
			operationId: "auth.setPassword",
			requestBody: requestBody(["password"]),
			responses: {
				...ok({ ok: { type: "boolean" } }, ["ok"]),
				"409": { description: "exists" },
			},
			"x-destructive": true,
		},
	}
	return document
}

async function servePasswordless(box: Map<string, string>): Promise<string> {
	const stamped = new Set<string>()
	return startServer(passwordlessSpec(), ({ method, path, body, token }) => {
		if (path === "/v1/login/magic-link" && method === "POST" && typeof body.email === "string") {
			box.set(`${body.email}:magic-link`, "magtok")
			return { body: { success: true }, status: 200 }
		}
		if (path === "/v1/login/magic-link/verify" && method === "POST") {
			if (body.token !== "magtok") return { body: { error_key: "magic_link_invalid" }, status: 400 }
			return { body: { access_token: "magic" }, status: 200 }
		}
		if (path === "/v1/reauth/code" && method === "POST") {
			box.set("oat-set-n1@example.test:security-code", "654321")
			return { body: { success: true }, status: 200 }
		}
		if (path === "/v1/reauth" && method === "POST") {
			if (token === "magic" && body.email_code === "654321") {
				stamped.add(token)
				return { body: { reauthenticated_until: Date.now() + 600_000 }, status: 200 }
			}
			if (token === "t1" && typeof body.password === "string") {
				stamped.add(token)
				return { body: { reauthenticated_until: Date.now() + 600_000 }, status: 200 }
			}
			return { body: { error_key: "account_reauth_failed" }, status: 403 }
		}
		if (path === "/v1/password/set" && method === "POST") {
			if (token === "t1") return { body: { error_key: "password_already_exists" }, status: 409 }
			if (token === "magic" && stamped.has(token)) return { body: { ok: true }, status: 200 }
			return { body: { error_key: "account_reauth_required" }, status: 403 }
		}
		return undefined
	})
}

function deviceSpec(): OpenApiDocument {
	const document = secondFactorSpec()
	const paths = document.paths as Record<string, Record<string, unknown>>
	const register = paths["/v1/register"]?.post as { requestBody: unknown }
	register.requestBody = requestBody(["email", "password"])
	paths["/v1/login"] = {
		post: {
			operationId: "auth.login",
			requestBody: requestBody(["email", "password"]),
			responses: ok(
				{ requires_2fa: { type: "boolean" }, temp_token: { type: "string" } },
				["requires_2fa", "temp_token"],
			),
		},
	}
	paths["/v1/login/verify"] = {
		post: {
			operationId: "auth.verify2fa",
			requestBody: requestBody(["code", "temp_token"], {
				trust_device: { type: "boolean" },
				type: { enum: ["backup", "totp"], type: "string" },
			}),
			responses: ok({ access_token: { type: "string" } }, ["access_token"]),
		},
	}
	paths["/v1/trusted-devices"] = {
		get: {
			operationId: "auth.listTrustedDevices",
			responses: ok(
				{
					devices: {
						items: {
							properties: { expires_at: { type: "number" }, id: { type: "string" } },
							type: "object",
						},
						type: "array",
					},
				},
				["devices"],
			),
		},
	}
	paths["/v1/trusted-devices/{id}"] = {
		delete: {
			operationId: "auth.forgetTrustedDevice",
			responses: ok({ forgotten: { type: "number" } }, ["forgotten"]),
			"x-destructive": true,
		},
	}
	return document
}

async function serveDevices(): Promise<string> {
	const devices: Array<{ expires_at: number; id: string }> = []
	let n = 0
	return startServer(deviceSpec(), ({ method, path, body }) => {
		if (path === "/v1/two-factor/setup" && method === "POST") {
			return { body: { otpauth_uri: "otpauth://totp/a?period=30", qr_code: "qr", secret: "SHHH" }, status: 200 }
		}
		if (path === "/v1/totp" && method === "POST") return { body: { code: String(100000 + n++) }, status: 200 }
		if (path === "/v1/two-factor/enable" && method === "POST") {
			if (typeof body.code !== "string") return { body: { error_key: "unsupported_media_type" }, status: 415 }
			return { body: { backup_codes: ["BACKUP-1"], enabled: true }, status: 200 }
		}
		if (path === "/v1/two-factor/backup-codes" && method === "POST") {
			return { body: { backup_codes: ["BACKUP-2"] }, status: 200 }
		}
		if (path === "/v1/two-factor/disable" && method === "POST") return { body: { disabled: true }, status: 200 }
		if (path === "/v1/login" && method === "POST") {
			return { body: { requires_2fa: true, temp_token: "tmp" }, status: 200 }
		}
		if (path === "/v1/login/verify" && method === "POST") {
			if (body.trust_device === true) devices.push({ expires_at: 1, id: "dev_1" })
			return { body: { access_token: "second" }, status: 200 }
		}
		if (path === "/v1/trusted-devices" && method === "GET") return { body: { devices }, status: 200 }
		if (path === "/v1/trusted-devices/dev_1" && method === "DELETE") return { body: { forgotten: 1 }, status: 200 }
		return undefined
	})
}

function ownershipSpec(): OpenApiDocument {
	const document = withoutLogout()
	const paths = document.paths as Record<string, Record<string, unknown>>
	const invite = (id: string, accept: string, kind: string) => ({
		post: {
			operationId: id,
			requestBody: requestBody(["invite_email"]),
			responses: ok({ id: { type: "string" } }, ["id"]),
			"x-invite": {
				accept,
				acceptFrom: "token",
				grantPointer: "$.id",
				granteeField: "invite_email",
				invite: id,
				revoke: `${id}.revoke`,
				tokenFrom: "outOfBand",
				tokenKind: kind,
				tokenPointer: "$.invite_token",
			},
		},
	})
	paths["/v1/refresh"] = {
		post: {
			operationId: "auth.refresh",
			requestBody: requestBody(["refresh_token"]),
			responses: ok({ access_token: { type: "string" }, refresh_token: { type: "string" } }, ["access_token"]),
		},
	}
	paths["/v1/organizations/{organization_id}/members"] = {
		...invite("org.invite", "org.accept", "org-invite"),
		get: {
			operationId: "org.listMembers",
			responses: ok(
				{
					members: {
						items: {
							properties: {
								id: { type: "string" },
								invite_email: { type: "string" },
								user_id: { type: "string" },
							},
							type: "object",
						},
						type: "array",
					},
				},
				["members"],
			),
		},
	}
	paths["/v1/organizations/invites/accept"] = {
		post: {
			operationId: "org.accept",
			requestBody: requestBody(["token"]),
			responses: ok({ id: { type: "string" } }, ["id"]),
		},
	}
	paths["/v1/organizations/{organization_id}/transfer"] = {
		post: {
			operationId: "org.transfer",
			requestBody: requestBody(["member_id"]),
			responses: ok({ ok: { type: "boolean" } }, ["ok"]),
		},
	}
	paths["/v1/organizations/{organization_id}/leave"] = {
		post: {
			operationId: "org.leave",
			responses: { ...ok({ ok: { type: "boolean" } }, ["ok"]), "403": { description: "owner" } },
			"x-destructive": true,
		},
	}
	paths["/v1/organizations/{organization_id}/projects"] = {
		post: {
			operationId: "project.create",
			requestBody: requestBody(["name"]),
			responses: ok({ id: { type: "string" } }, ["id"]),
		},
	}
	paths["/v1/projects/{project_id}/collaborators"] = invite("project.invite", "project.accept", "project-invite")
	paths["/v1/projects/collaborators/accept"] = {
		post: {
			operationId: "project.accept",
			requestBody: requestBody(["token"]),
			responses: ok({ id: { type: "string" } }, ["id"]),
		},
	}
	paths["/v1/projects/{project_id}/members"] = {
		post: {
			operationId: "project.addMember",
			requestBody: requestBody(["user_id"]),
			responses: ok({ id: { type: "string" } }, ["id"]),
		},
		get: {
			operationId: "project.listMembers",
			responses: ok(
				{
					members: {
						items: { properties: { id: { type: "string" }, invite_email: { type: "string" } }, type: "object" },
						type: "array",
					},
				},
				["members"],
			),
		},
	}
	paths["/v1/projects/{project_id}/transfer"] = {
		post: {
			operationId: "project.transfer",
			requestBody: requestBody(["member_id"]),
			responses: ok({ ok: { type: "boolean" } }, ["ok"]),
		},
	}
	paths["/v1/projects/{project_id}/leave"] = {
		post: {
			operationId: "project.leave",
			responses: {
				...ok({ ok: { type: "boolean" } }, ["ok"]),
				"403": { description: "owner" },
				"404": { description: "missing" },
			},
			"x-destructive": true,
		},
	}
	paths["/v1/test/last-mail"] = {
		get: {
			operationId: "test.lastMail",
			parameters: [
				{ in: "query", name: "type", schema: { enum: ["org-invite", "project-invite"], type: "string" } },
			],
			responses: { "200": { description: "ok" } },
		},
	}
	return document
}

async function serveOwnership(box: Map<string, string>): Promise<string> {
	const document = ownershipSpec()
	const names = new Map<string, string>([
		["suite", "Ada"],
		["disp", "Ada"],
	])
	let orgOwner = "disp"
	let projectOwner = "disp"
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
			const send = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(payload))
			}
			if (url.pathname === "/v1/register" && method === "POST") {
				const email = body.email
				const access = email === "suite@example.test" ? "suite" : "disp"
				send(201, {
					access_token: access,
					organization_id: "org_1",
					project_id: "proj_wrong",
					refresh_token: `${access}-r`,
				})
				return
			}
			if (url.pathname === "/v1/refresh" && method === "POST") {
				send(200, { access_token: "suite", refresh_token: "suite-r" })
				return
			}
			if (url.pathname === "/v1/me" && (method === "GET" || method === "PATCH")) {
				if (!names.has(token)) return send(401, { error: "unauthorized" })
				if (method === "PATCH" && typeof body.first_name === "string") names.set(token, body.first_name)
				send(200, { first_name: names.get(token) })
				return
			}
			if (url.pathname === "/v1/organizations/org_1/members" && method === "POST") {
				box.set(`${String(body.invite_email)}:org-invite`, "orgtok")
				send(201, { id: "mem_suite" })
				return
			}
			if (url.pathname === "/v1/organizations/invites/accept" && method === "POST") {
				if (body.token !== "orgtok" || token !== "suite") return send(403, { error_key: "invite_email_mismatch" })
				send(200, { id: "mem_suite" })
				return
			}
			if (url.pathname === "/v1/organizations/org_1/members" && method === "GET") {
				send(200, {
					members: [
						{ accepted_at: null, id: "mem_pending", invite_email: "suite@example.test", user_id: "usr_pending" },
						{ accepted_at: 1, id: "mem_suite", invite_email: "suite@example.test", user_id: "usr_suite" },
					],
				})
				return
			}
			if (url.pathname === "/v1/organizations/org_1/transfer" && method === "POST") {
				if (body.member_id !== "mem_suite") return send(404, { error_key: "member_not_found" })
				orgOwner = "suite"
				send(200, { ok: true })
				return
			}
			if (url.pathname === "/v1/organizations/org_1/leave" && method === "POST") {
				if (orgOwner === "disp") return send(403, { error_key: "member_last_owner" })
				send(200, { ok: true })
				return
			}
			if (url.pathname === "/v1/organizations/org_1/projects" && method === "POST") {
				send(201, { id: "proj_new" })
				return
			}
			if (url.pathname === "/v1/projects/proj_new/collaborators" && method === "POST") {
				box.set(`${String(body.invite_email)}:project-invite`, "projtok")
				send(201, { id: "pmem_suite" })
				return
			}
			if (url.pathname === "/v1/projects/collaborators/accept" && method === "POST") {
				if (body.token !== "projtok" || token !== "suite") return send(403, { error_key: "invite_email_mismatch" })
				send(200, { id: "pmem_suite" })
				return
			}
			if (method === "GET" && url.pathname.startsWith("/v1/projects/") && url.pathname.endsWith("/members")) {
				const members =
					url.pathname === "/v1/projects/proj_new/members"
						? [{ id: "pmem_suite", invite_email: "suite@example.test" }]
						: []
				send(200, { members })
				return
			}
			if (method === "POST" && url.pathname.endsWith("/members") && url.pathname.startsWith("/v1/projects/")) {
				if (body.user_id !== "usr_suite") return send(404, { error_key: "project_member_not_org_member" })
				send(201, { id: "pmem_direct" })
				return
			}
			if (url.pathname === "/v1/projects/proj_new/transfer" && method === "POST") {
				if (body.member_id !== "pmem_direct") return send(403, { error_key: "project_member_transfer_collaborator" })
				projectOwner = "suite"
				send(200, { ok: true })
				return
			}
			if (url.pathname.endsWith("/leave") && method === "POST" && url.pathname.startsWith("/v1/projects/")) {
				if (url.pathname !== "/v1/projects/proj_new/leave") return send(404, { error_key: "project_member_not_found" })
				if (projectOwner === "disp") return send(403, { error_key: "project_member_last_owner" })
				send(200, { ok: true })
				return
			}
			send(404, { error: "missing" })
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

describe("disposable principal", () => {
	it("builds the standard TOTP code from a base32 secret", () => {
		const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
		expect(totpCode(secret, 0, 30, 6)).toBe("755224")
		expect(totpCode(secret, 59_000, 30, 6)).toBe("287082")
	})

	it("sends a code computed from the otpauth secret when the spec has no code door", async () => {
		const document = secondFactorSpec()
		delete (document.paths as Record<string, unknown>)["/v1/totp"]
		delete (document.paths as Record<string, unknown>)["/v1/two-factor/backup-codes"]
		delete (document.paths as Record<string, unknown>)["/v1/two-factor/disable"]
		const url = await startServer(document, ({ method, path, body }) => {
			if (path === "/v1/two-factor/setup" && method === "POST") {
				return {
					body: { otpauth_uri: "otpauth://totp/a?digits=6&period=30&secret=SHHH", qr_code: "qr", secret: "SHHH" },
					status: 200,
				}
			}
			if (path === "/v1/two-factor/enable" && method === "POST") {
				const now = Date.now()
				const okCode =
					body.code === totpCode("SHHH", now, 30, 6) || body.code === totpCode("SHHH", now - 30_000, 30, 6)
				if (!okCode) return { body: { error_key: "two_factor_code_invalid" }, status: 400 }
				return { body: { backup_codes: ["BACKUP-1"], enabled: true }, status: 200 }
			}
			return undefined
		})
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.enable2fa")?.status).toBe("passed")
	})

	it("rewrites only the signup email", () => {
		const flow = freshSignupFlow(
			{
				credentialFrom: "$.access_token",
				steps: [
					{
						bind: { address: "a@b.c" },
						body: { email: "a@b.c", password: "secret" },
						operationId: "auth.register",
					},
					{ outOfBand: { address: "a@b.c", as: "link", kind: "email-verify" } },
				],
			},
			"new@b.c",
		)
		expect(flow.steps[0]).toMatchObject({
			bind: { address: "new@b.c" },
			body: { email: "new@b.c", password: "secret" },
		})
		expect(flow.steps[1]).toMatchObject({ outOfBand: { address: "new@b.c" } })
		expect(
			disposableAddress(
				{
					credentialFrom: "$.access_token",
					steps: [{ body: { email: "oat-alpha@anyrow.ai" }, operationId: "auth.register" }],
				},
				"abc",
			),
		).toBe("oat-disp-abc@anyrow.ai")
	})

	it("logs out a second registered user and leaves the suite session able to read", async () => {
		const url = await serve(false)
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.logout")?.status).toBe("passed")
		const logoutAt = result.client.transcript.findIndex(
			(exchange) => exchange.method === "POST" && exchange.url.endsWith("/v1/logout"),
		)
		expect(logoutAt).toBeGreaterThanOrEqual(0)
		const logout = result.client.transcript[logoutAt]
		const registered = result.client.transcript.find(
			(exchange) => exchange.method === "POST" && exchange.url.endsWith("/v1/register"),
		)
		const email = (registered?.requestBody as { email?: unknown } | undefined)?.email
		expect(email).toEqual(expect.stringContaining("@"))
		expect(email).not.toBe("oat-baseline-0@example.test")
		expect(logout?.requestHeaders.authorization).not.toBe("Bearer alpha")
		const after = result.client.transcript.slice(logoutAt + 1)
		expect(
			after.some(
				(exchange) =>
					exchange.method === "GET" &&
					exchange.url.endsWith("/v1/me") &&
					exchange.requestHeaders.authorization === "Bearer alpha" &&
					exchange.status === 200,
			),
		).toBe(true)
		expect(
			after.some(
				(exchange) =>
					exchange.method === "GET" &&
					exchange.url.endsWith("/v1/me") &&
					exchange.requestHeaders.authorization !== "Bearer alpha" &&
					exchange.status === 401,
			),
		).toBe(true)
	})

	it("accepts a logout that kills the refresh token and leaves the access token alive", async () => {
		const url = await serveRefresh(false)
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.logout")?.status).toBe("passed")
		const logoutAt = result.client.transcript.findIndex((exchange) => exchange.url.endsWith("/v1/logout"))
		const after = result.client.transcript.slice(logoutAt + 1)
		expect(after.some((exchange) => exchange.url.endsWith("/v1/refresh") && exchange.status === 401)).toBe(true)
		expect(
			after.some(
				(exchange) =>
					exchange.url.endsWith("/v1/me") &&
					exchange.requestHeaders.authorization === "Bearer alpha" &&
					exchange.status === 200,
			),
		).toBe(true)
	})

	it("reports a logout whose refresh token still renews", async () => {
		const url = await serveRefresh(true)
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.summary ?? finding.check)).toContain(
			"the disposable session was still accepted",
		)
	})

	it("reauths on the token a password change just issued", async () => {
		const url = await servePasswordRotation()
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.setPassword")?.status).toBe("passed")
		const set = result.client.transcript.filter((exchange) => exchange.url.endsWith("/v1/password/set"))
		expect(set.at(-1)?.status).toBe(200)
		expect(set.at(-1)?.requestHeaders.authorization).toBe("Bearer t2")
	})

	it("sends a one-time code taken from the secret a setup call returned", async () => {
		const url = await serveSecondFactor()
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		for (const id of ["auth.setup2fa", "auth.enable2fa", "auth.regenerateBackupCodes", "auth.disable2fa"]) {
			expect(result.scope.operations.find((op) => op.operationId === id)?.status).toBe("passed")
		}
		const enable = result.client.transcript.find((exchange) => exchange.url.endsWith("/v1/two-factor/enable"))
		expect(enable?.requestBody).toEqual({ code: "100000" })
		const at = (suffix: string) => result.client.transcript.findIndex((exchange) => exchange.url.endsWith(suffix))
		expect(at("/v1/two-factor/setup")).toBeLessThan(at("/v1/two-factor/enable"))
		expect(at("/v1/two-factor/enable")).toBeLessThan(at("/v1/two-factor/backup-codes"))
		expect(at("/v1/two-factor/backup-codes")).toBeLessThan(at("/v1/two-factor/disable"))
	})

	it("revokes a session that is not the current one", async () => {
		const url = await serveSessions()
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.revokeSession")?.status).toBe("passed")
		const revoke = result.client.transcript.find((exchange) => exchange.url.endsWith("/v1/sessions/revoke"))
		expect(revoke?.requestBody).toEqual({ family_id: "fam-other" })
		expect(revoke?.requestHeaders.authorization).toBe("Bearer t1")
	})

	it("sets a password on an account that does not have one", async () => {
		const box = new Map<string, string>()
		const url = await servePasswordless(box)
		const result = await run({
			baseUrl: url,
			hooks: { resolveOutOfBand: async (req) => box.get(`${req.address}:${req.kind}`) ?? null },
			nonce: "n1",
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.setPassword")?.status).toBe("passed")
		const sets = result.client.transcript.filter((exchange) => exchange.url.endsWith("/v1/password/set"))
		expect(sets.at(-1)?.status).toBe(200)
		expect(sets.at(-1)?.requestHeaders.authorization).toBe("Bearer magic")
		expect(sets.some((exchange) => exchange.status === 409)).toBe(true)
	})

	it("trusts a browser, then forgets that one device", async () => {
		const url = await serveDevices()
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.forgetTrustedDevice")?.status).toBe("passed")
		const forgotten = result.client.transcript.find((exchange) => exchange.method === "DELETE")
		expect(forgotten?.url.endsWith("/v1/trusted-devices/dev_1")).toBe(true)
		const verify = result.client.transcript.find((exchange) => exchange.url.endsWith("/v1/login/verify"))
		expect(verify?.requestBody).toMatchObject({ trust_device: true, type: "backup" })
	})

	it("hands ownership off when the caller is the last owner, and joins a project it can leave", async () => {
		const box = new Map<string, string>()
		const url = await serveOwnership(box)
		const result = await run({
			baseUrl: url,
			hooks: { resolveOutOfBand: async (req) => box.get(`${req.address}:${req.kind}`) ?? null },
			nonce: "n1",
			principals: [
				{
					auth: {
						credentialFrom: "$.access_token",
						refresh: {
							steps: [
								{
									body: { refresh_token: "{refreshToken}" },
									operationId: "auth.refresh",
									saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
								},
							],
						},
						steps: [
							{
								body: { email: "suite@example.test", password: "secret" },
								operationId: "auth.register",
								saveAs: {
									credential: "$.access_token",
									organization_id: "$.organization_id",
									projectId: "$.project_id",
									refreshToken: "$.refresh_token",
								},
							},
						],
					},
					id: "alpha",
					rootsFromFlow: { organization_id: "organization_id", project_id: "projectId" },
				},
			],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "org.leave")?.status).toBe("passed")
		expect(result.scope.operations.find((op) => op.operationId === "project.leave")?.status).toBe("passed")
		const leaves = result.client.transcript.filter((exchange) => exchange.url.endsWith("/leave") && exchange.status === 200)
		expect(leaves.map((exchange) => new URL(exchange.url).pathname).sort()).toEqual([
			"/v1/organizations/org_1/leave",
			"/v1/projects/proj_new/leave",
		])
	})

	it("reports a logout that also kills the suite session", async () => {
		const url = await serve(true)
		const result = await runDisposable(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.check)).toContain("auth.destructive-spares-the-caller")
		expect(result.scope.operations.find((op) => op.operationId === "profile.read")?.status).not.toBe("failed")
	})
})
