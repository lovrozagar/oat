import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { buildModel } from "../src/spec/graph.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { mailHint, mailPairs } from "../src/runtime/mail.ts"
import { run } from "../src/runtime/run.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])
let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function document(): OpenApiDocument {
	const profile = {
		properties: { email: { type: "string" }, first_name: { type: "string" } },
		required: ["email", "first_name"],
		type: "object",
	}
	const tokenBody = (extra?: Record<string, unknown>, required: string[] = ["token"]) => ({
		content: {
			"application/json": {
				schema: {
					properties: { token: { type: "string" }, ...extra },
					required,
					type: "object",
				},
			},
		},
		required: true,
	})
	const ok = (properties: Record<string, unknown>, required: string[]) => ({
		"200": {
			content: { "application/json": { schema: { properties, required, type: "object" } } },
			description: "ok",
		},
		"401": { description: "unauthorized" },
	})
	return {
		info: { title: "mail", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: {
						"200": { content: { "application/json": { schema: profile } }, description: "ok" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
			},
			"/v1/register": {
				post: {
					operationId: "auth.register",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { email: { type: "string" }, password: { type: "string" } },
									required: ["email", "password"],
									type: "object",
								},
							},
						},
						required: true,
					},
					responses: ok({ access_token: { type: "string" } }, ["access_token"]),
					"x-fresh-principal": true,
				},
			},
			"/v1/auth/login/magic-link": {
				post: {
					operationId: "auth.loginMagicLink",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
							},
						},
						required: true,
					},
					responses: ok({ success: { type: "boolean" } }, ["success"]),
					summary: "Send magic link email",
				},
			},
			"/v1/auth/login/magic-link/verify": {
				post: {
					operationId: "auth.loginMagicLinkVerify",
					requestBody: tokenBody(),
					responses: ok({ access_token: { type: "string" } }, ["access_token"]),
					summary: "Verify magic link token",
				},
			},
			"/v1/auth/password/request-reset": {
				post: {
					operationId: "auth.requestPasswordReset",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
							},
						},
						required: true,
					},
					responses: ok({ success: { type: "boolean" } }, ["success"]),
					summary: "Request password reset email",
				},
			},
			"/v1/auth/password/reset": {
				post: {
					operationId: "auth.resetPassword",
					requestBody: tokenBody({ password: { type: "string" } }, ["password", "token"]),
					responses: ok({ access_token: { type: "string" } }, ["access_token"]),
					summary: "Reset password with token",
				},
			},
		},
	} as OpenApiDocument
}

async function serve(acceptFollowUp: boolean): Promise<{ box: Map<string, string>; url: string }> {
	const box = new Map<string, string>()
	const names = new Map<string, string>([["alpha", "Ada"]])
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(chunk as Buffer)
			const raw = Buffer.concat(chunks).toString("utf8")
			const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
			const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
			const send = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(payload))
			}
			if (url.pathname === "/openapi.json" && method === "GET") return send(200, document())
			if (url.pathname === "/v1/register" && method === "POST") {
				names.set("t-reg", "Ada")
				return send(201, { access_token: "t-reg" })
			}
			if (url.pathname === "/v1/me" && method === "GET") {
				if (token === "t-magic" && !acceptFollowUp) return send(401, { error: "unauthorized" })
				if (!names.has(token) && token !== "t-magic" && token !== "t-reset") return send(401, { error: "unauthorized" })
				return send(200, { email: "ada@example.test", first_name: "Ada" })
			}
			if (url.pathname === "/v1/auth/login/magic-link" && method === "POST") {
				box.set(String(body.email), "tok-magic")
				return send(200, { success: true })
			}
			if (url.pathname === "/v1/auth/login/magic-link/verify" && method === "POST") {
				if (body.token !== "tok-magic") return send(400, { error_key: "bad_token" })
				names.set("t-magic", "Ada")
				return send(200, { access_token: "t-magic" })
			}
			if (url.pathname === "/v1/auth/password/request-reset" && method === "POST") {
				box.set(String(body.email), "https://example.test/reset-password?token=tok-reset")
				return send(200, { success: true })
			}
			if (url.pathname === "/v1/auth/password/reset" && method === "POST") {
				if (body.token !== "tok-reset") return send(400, { error_key: "bad_token" })
				names.set("t-reset", "Ada")
				return send(200, { access_token: "t-reset" })
			}
			return send(404, { error: "missing" })
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return { box, url }
}

function verifyDocument(): OpenApiDocument {
	const base = document()
	return {
		...base,
		paths: {
			"/v1/me": base.paths["/v1/me"],
			"/v1/register": base.paths["/v1/register"],
			"/v1/auth/email/request-verification": {
				post: {
					operationId: "auth.requestEmailVerification",
					responses: { "200": { description: "ok" } },
					security: [{ jwt: [] }],
				},
			},
			"/v1/auth/email/verify": {
				post: {
					operationId: "auth.verifyEmail",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { token: { type: "string" } }, required: ["token"], type: "object" },
							},
						},
						required: true,
					},
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { access_token: { type: "string" } },
										required: ["access_token"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-invalidate": ["GET /v1/me"],
				},
			},
		},
	} as OpenApiDocument
}

function changeDocument(): OpenApiDocument {
	const base = document()
	const tokenBody = (extra: Record<string, unknown>, required: string[]) => ({
		content: {
			"application/json": {
				schema: { properties: { token: { type: "string" }, ...extra }, required, type: "object" },
			},
		},
		required: true,
	})
	return {
		...base,
		paths: {
			"/v1/me": base.paths["/v1/me"],
			"/v1/register": base.paths["/v1/register"],
			"/v1/auth/email/request-verification": {
				post: {
					operationId: "auth.requestEmailVerification",
					responses: { "200": { description: "ok" } },
					security: [{ jwt: [] }],
				},
			},
			"/v1/auth/email/verify": {
				post: {
					operationId: "auth.verifyEmail",
					requestBody: tokenBody({}, ["token"]),
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { access_token: { type: "string" } },
										required: ["access_token"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-invalidate": ["GET /v1/me"],
				},
			},
			"/v1/auth/reauth": {
				post: {
					operationId: "auth.reauthenticate",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { password: { type: "string" } }, required: ["password"], type: "object" },
							},
						},
						required: true,
					},
					responses: { "200": { description: "ok" } },
					security: [{ jwt: [] }],
				},
			},
			"/v1/auth/email/change/request": {
				post: {
					operationId: "auth.requestEmailChange",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { new_email: { type: "string" } }, required: ["new_email"], type: "object" },
							},
						},
						required: true,
					},
					responses: { "200": { description: "ok" } },
					security: [{ jwt: [] }],
				},
			},
			"/v1/auth/email/change/confirm": {
				post: {
					operationId: "auth.confirmEmailChange",
					requestBody: tokenBody({ confirmation_type: { enum: ["new", "old"], type: "string" } }, [
						"confirmation_type",
						"token",
					]),
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { access_token: { type: "string" }, completed: { type: "boolean" } },
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-invalidate": ["GET /v1/me"],
				},
			},
		},
	} as OpenApiDocument
}

function newsletterDocument(): OpenApiDocument {
	const base = document()
	const token = (extra: Record<string, unknown> = {}) => ({
		content: {
			"application/json": {
				schema: { properties: { token: { type: "string" }, ...extra }, required: ["token"], type: "object" },
			},
		},
		required: true,
	})
	return {
		...base,
		paths: {
			"/v1/me": base.paths["/v1/me"],
			"/v1/register": base.paths["/v1/register"],
			"/v1/newsletter/subscribe": {
				post: {
					operationId: "newsletter.subscribe",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
							},
						},
						required: true,
					},
					responses: { "202": { description: "accepted" } },
				},
			},
			"/v1/newsletter/preferences": {
				get: {
					operationId: "newsletterPreference.get",
					parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }],
					responses: { "200": { description: "ok" } },
				},
				post: {
					operationId: "newsletterPreference.update",
					requestBody: token({ topic_ids: { items: { type: "string" }, type: "array" } }),
					responses: { "200": { description: "ok" } },
					"x-invalidate": ["GET /v1/newsletter/preferences"],
				},
			},
			"/v1/newsletter/unsubscribe": {
				post: {
					operationId: "newsletter.unsubscribe",
					requestBody: token(),
					responses: { "200": { description: "ok" } },
					"x-invalidate": ["GET /v1/newsletter/preferences"],
				},
			},
		},
	} as OpenApiDocument
}

function unsubscribeGetDocument(): OpenApiDocument {
	const base = newsletterDocument()
	return {
		...base,
		paths: {
			...base.paths,
			"/v1/newsletter/unsubscribe": {
				get: {
					operationId: "newsletter.unsubscribeGet",
					parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }],
					responses: { "200": { description: "ok" } },
					"x-invalidate": ["GET /v1/newsletter/preferences"],
				},
			},
		},
	} as OpenApiDocument
}

function inviteDocument(): OpenApiDocument {
	const base = document()
	const inviteTag = (accept: string) => ({
		accept,
		acceptFrom: "token",
		granteeField: "invite_email",
		grantPointer: "$.id",
		invite: "pending",
		revoke: "pending",
		tokenFrom: "outOfBand",
		tokenKind: "project-invite",
		tokenPointer: "$.invite_token",
	})
	return {
		...base,
		paths: {
			"/v1/me": base.paths["/v1/me"],
			"/v1/register": base.paths["/v1/register"],
			"/v1/projects/{project_id}/collaborators": {
				post: {
					operationId: "project.inviteCollaborator",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
							},
						},
						required: true,
					},
					responses: { "201": { description: "created" } },
					"x-invite": { ...inviteTag("project.acceptCollaboratorInvite"), granteeField: "email" },
				},
			},
			"/v1/projects/collaborators/accept": {
				post: {
					operationId: "project.acceptCollaboratorInvite",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { token: { type: "string" } }, required: ["token"], type: "object" },
							},
						},
						required: true,
					},
					responses: { "200": { description: "ok" } },
					"x-invalidate": ["GET /v1/invites"],
				},
			},
			"/v1/projects/{project_id}/members": {
				get: {
					operationId: "project.listMembers",
					responses: { "200": { description: "ok" } },
				},
			},
			"/v1/projects/{project_id}/collaborators/{member_id}/resend": {
				post: {
					operationId: "project.resendCollaboratorInvite",
					responses: { "200": { description: "ok" } },
				},
			},
			"/v1/organizations/{organization_id}/members": {
				post: {
					operationId: "org.inviteMember",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { invite_email: { type: "string" } },
									required: ["invite_email"],
									type: "object",
								},
							},
						},
						required: true,
					},
					responses: { "201": { description: "created" } },
					"x-invite": inviteTag("org.acceptInvite"),
				},
			},
			"/v1/invites": {
				get: { operationId: "invite.list", responses: { "200": { description: "ok" } } },
			},
			"/v1/invites/{invite_id}/decline": {
				post: {
					operationId: "invite.decline",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { sid: { type: "number" }, type: { type: "string" } },
									required: ["sid", "type"],
									type: "object",
								},
							},
						},
						required: true,
					},
					responses: { "200": { description: "ok" } },
					"x-invalidate": ["GET /v1/invites"],
				},
			},
		},
	} as OpenApiDocument
}

async function runMail(url: string, box: Map<string, string>) {
	return run({
		baseUrl: url,
		hooks: { resolveOutOfBand: async (req) => box.get(req.address) ?? null },
		nonce: "n1",
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("mail token", () => {
	it("pairs a token call with the post that shares its path", async () => {
		const loaded = buildModel(document())
		const pairs = mailPairs(loaded)
		expect(pairs.map((pair) => [pair.sender.operationId, pair.consumer.operationId])).toEqual([
			["auth.loginMagicLink", "auth.loginMagicLinkVerify"],
			["auth.requestPasswordReset", "auth.resetPassword"],
		])
		expect(mailHint(loaded, pairs[0]!.sender)).toContain("magic-link")
		const withChange = buildModel({
			...document(),
			paths: {
				...document().paths,
				"/v1/auth/email/verify": {
					post: {
						operationId: "auth.verifyEmail",
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { token: { type: "string" } }, required: ["token"], type: "object" },
								},
							},
							required: true,
						},
						responses: { "200": { description: "ok" } },
					},
				},
				"/v1/auth/email/change/request": {
					post: {
						operationId: "auth.requestEmailChange",
						requestBody: {
							content: {
								"application/json": {
									schema: {
										properties: { new_email: { type: "string" } },
										required: ["new_email"],
										type: "object",
									},
								},
							},
							required: true,
						},
						responses: { "200": { description: "ok" } },
					},
				},
				"/v1/auth/email/request-verification": {
					post: {
						operationId: "auth.requestEmailVerification",
						responses: { "200": { description: "ok" } },
					},
				},
			},
		})
		const verify = mailPairs(withChange).find((pair) => pair.consumer.operationId === "auth.verifyEmail")
		expect(verify?.sender.operationId).toBe("auth.requestEmailVerification")
		expect(mailHint(loaded, pairs[1]!.sender)).toContain("reset")
	})

	it("spends the mailed token and reads the profile it issued", async () => {
		const { box, url } = await serve(true)
		const result = await runMail(url, box)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "auth.loginMagicLinkVerify")?.status).toBe("passed")
		expect(result.scope.operations.find((op) => op.operationId === "auth.resetPassword")?.status).toBe("passed")
		const magic = result.client.transcript.find((exchange) => exchange.url.endsWith("/magic-link/verify"))
		expect(magic?.requestBody).toEqual({ token: "tok-magic" })
		const reset = result.client.transcript.find((exchange) => exchange.url.endsWith("/password/reset"))
		expect(reset?.requestBody).toMatchObject({ token: "tok-reset" })
		const mailed = result.client.transcript.filter(
			(exchange) => exchange.url.includes("magic-link") || exchange.url.includes("password"),
		)
		expect(mailed.some((exchange) => JSON.stringify(exchange.requestBody).includes("alpha"))).toBe(false)
	})

	it("passes email verify only when the caller read changes", async () => {
		for (const flip of [false, true]) {
			const box = new Map<string, string>()
			let verified = false
			const server = createServer((req: IncomingMessage, res: ServerResponse) => {
				void (async () => {
					const url = new URL(req.url ?? "/", "http://127.0.0.1")
					const method = (req.method ?? "GET").toUpperCase()
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					const raw = Buffer.concat(chunks).toString("utf8")
					const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
					const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
					const send = (status: number, payload: unknown) => {
						res.writeHead(status, { "content-type": "application/json" })
						res.end(JSON.stringify(payload))
					}
					if (url.pathname === "/openapi.json" && method === "GET") return send(200, verifyDocument())
					if (url.pathname === "/v1/register" && method === "POST") return send(201, { access_token: "t-reg" })
					if (url.pathname === "/v1/me" && method === "GET") {
						if (token === "alpha") return send(200, { email: "alpha@example.test", first_name: "Ada" })
						if (token !== "t-reg" && token !== "t-verified") return send(401, { error: "unauthorized" })
						return send(200, { email: "mail@example.test", first_name: "Ada", verified })
					}
					if (url.pathname === "/v1/auth/email/request-verification" && method === "POST") {
						box.set("pending", "https://example.test/verify-email?token=tok-verify")
						return send(200, { success: true })
					}
					if (url.pathname === "/v1/auth/email/verify" && method === "POST") {
						if (body.token !== "tok-verify") return send(400, { error_key: "bad_token" })
						if (flip) verified = true
						return send(200, { access_token: "t-verified" })
					}
					return send(404, { error: "missing" })
				})()
			})
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
			open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
			const result = await run({
				baseUrl: url,
				hooks: { resolveOutOfBand: async () => box.get("pending") ?? null },
				nonce: "n1",
				principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
				seed: 1,
				spec: `${url}/openapi.json`,
			})
			const status = result.scope.operations.find((op) => op.operationId === "auth.verifyEmail")?.status
			expect(status).toBe(flip ? "passed" : "failed")
		}
	})

	it("ignores a verification mail that arrived before this send", async () => {
		let sent = false
		let verified = false
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, verifyDocument())
				if (url.pathname === "/v1/register" && method === "POST") return send(201, { access_token: "t-reg" })
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "alpha") return send(200, { email: "alpha@example.test", first_name: "Ada" })
					if (token !== "t-reg" && token !== "t-verified") return send(401, { error: "unauthorized" })
					return send(200, { email: "mail@example.test", first_name: "Ada", verified })
				}
				if (url.pathname === "/v1/auth/email/request-verification" && method === "POST") {
					sent = true
					return send(200, { success: true })
				}
				if (url.pathname === "/v1/auth/email/verify" && method === "POST") {
					if (body.token !== "tok-verify") return send(400, { error_key: "bad_token" })
					verified = true
					return send(200, { access_token: "t-verified" })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const oldLink = "https://example.test/verify-email?token=tok-old"
		const newLink = "https://example.test/verify-email?token=tok-verify"
		const result = await run({
			baseUrl: url,
			hooks: { resolveOutOfBand: async () => (sent ? newLink : oldLink) },
			nonce: "n1",
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "auth.verifyEmail")?.status).toBe("passed")
		expect(verified).toBe(true)
	})

	it("discards a verification token that the send already replaced", async () => {
		let sent = false
		let polls = 0
		let verified = false
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, verifyDocument())
				if (url.pathname === "/v1/register" && method === "POST") return send(201, { access_token: "t-reg" })
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "alpha") return send(200, { email: "alpha@example.test", first_name: "Ada" })
					if (token !== "t-reg" && token !== "t-verified") return send(401, { error: "unauthorized" })
					return send(200, { email: "mail@example.test", first_name: "Ada", verified })
				}
				if (url.pathname === "/v1/auth/email/request-verification" && method === "POST") {
					sent = true
					return send(200, { success: true })
				}
				if (url.pathname === "/v1/auth/email/verify" && method === "POST") {
					if (body.token !== "tok-verify") return send(400, { error_key: "email_verification_code_invalid" })
					verified = true
					return send(200, { access_token: "t-verified" })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const oldLink = "https://example.test/verify-email?token=tok-old"
		const newLink = "https://example.test/verify-email?token=tok-verify"
		const result = await run({
			baseUrl: url,
			hooks: {
				resolveOutOfBand: async () => {
					if (!sent) return null
					polls += 1
					return polls === 1 ? oldLink : newLink
				},
			},
			nonce: "n1",
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "auth.verifyEmail")?.status).toBe("passed")
		expect(verified).toBe(true)
	})

	it("pairs a code child, a newsletter sibling, and a collaborator invite", () => {
		const loaded = buildModel({
			...document(),
			paths: {
				...document().paths,
				"/v1/auth/reauth": {
					post: {
						operationId: "auth.reauthenticate",
						requestBody: {
							content: {
								"application/json": {
									schema: {
										properties: { email_code: { type: "string" }, password: { type: "string" } },
										type: "object",
									},
								},
							},
							required: true,
						},
						responses: { "200": { description: "ok" } },
					},
				},
				"/v1/auth/reauth/code": {
					post: {
						operationId: "auth.requestReauthCode",
						responses: { "200": { description: "ok" } },
						summary: "Email a security code",
					},
				},
				"/v1/newsletter/subscribe": {
					post: {
						operationId: "newsletter.subscribe",
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
								},
							},
							required: true,
						},
						responses: { "202": { description: "accepted" } },
					},
				},
				"/v1/newsletter/unsubscribe": {
					post: {
						operationId: "newsletter.unsubscribe",
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { token: { type: "string" } }, required: ["token"], type: "object" },
								},
							},
							required: true,
						},
						responses: { "200": { description: "ok" } },
					},
				},
				"/v1/newsletter/preferences": {
					post: {
						operationId: "newsletterPreference.update",
						requestBody: {
							content: {
								"application/json": {
									schema: {
										properties: { token: { type: "string" }, topic_ids: { items: { type: "string" }, type: "array" } },
										required: ["token"],
										type: "object",
									},
								},
							},
							required: true,
						},
						responses: { "200": { description: "ok" } },
					},
				},
				"/v1/projects/{project_id}/collaborators": {
					post: {
						operationId: "project.inviteCollaborator",
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
								},
							},
							required: true,
						},
						responses: { "201": { description: "created" } },
					},
				},
				"/v1/projects/collaborators/accept": {
					post: {
						operationId: "project.acceptCollaboratorInvite",
						requestBody: {
							content: {
								"application/json": {
									schema: { properties: { token: { type: "string" } }, required: ["token"], type: "object" },
								},
							},
							required: true,
						},
						responses: { "200": { description: "ok" } },
					},
				},
				"/v1/invites/{invite_id}/decline": {
					post: {
						operationId: "invite.decline",
						requestBody: {
							content: {
								"application/json": {
									schema: {
										properties: { sid: { type: "number" }, type: { type: "string" } },
										required: ["sid", "type"],
										type: "object",
									},
								},
							},
							required: true,
						},
						responses: { "200": { description: "ok" } },
					},
				},
			},
		})
		const pairs = mailPairs(loaded)
		const id = (operationId: string) =>
			pairs.find((pair) => pair.consumer.operationId === operationId)?.sender.operationId
		expect(id("auth.reauthenticate")).toBe("auth.requestReauthCode")
		expect(id("newsletter.unsubscribe")).toBe("newsletter.subscribe")
		expect(id("newsletterPreference.update")).toBe("newsletter.subscribe")
		expect(id("project.acceptCollaboratorInvite")).toBe("project.inviteCollaborator")
		expect(id("invite.decline")).toBeUndefined()
	})

	it("verifies and reauthenticates before an email change", async () => {
		const verifyMail = new Map<string, string>()
		const changeMail = new Map<string, string>()
		const verifyToken = new Map<string, string>()
		const changeToken = new Map<string, string>()
		const sessions = new Map<string, string>()
		const users = new Map<
			string,
			{ confirmed: Set<string>; email: string; next: string; reauthed: boolean; verified: boolean }
		>()
		let sequence = 0
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				const user = () => {
					const email = sessions.get(token)
					return email === undefined ? undefined : users.get(email)
				}
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, changeDocument())
				if (url.pathname === "/v1/register" && method === "POST") {
					const email = String(body.email)
					users.set(email, { confirmed: new Set(), email, next: "", reauthed: false, verified: false })
					const access = `reg-${sequence}`
					sequence += 1
					sessions.set(access, email)
					return send(201, { access_token: access })
				}
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "alpha") return send(200, { email: "alpha@example.test", first_name: "Ada" })
					const account = user()
					if (account === undefined) return send(401, { error: "unauthorized" })
					return send(200, { email: account.email, verified: account.verified })
				}
				if (url.pathname === "/v1/auth/email/request-verification" && method === "POST") {
					const account = user()
					if (account === undefined) return send(401, { error: "unauthorized" })
					const mailed = `verify-${sequence}`
					sequence += 1
					verifyToken.set(mailed, sessions.get(token) ?? account.email)
					verifyMail.set(account.email, `https://example.test/verify-email?token=${encodeURIComponent(mailed)}`)
					return send(200, { success: true })
				}
				if (url.pathname === "/v1/auth/email/verify" && method === "POST") {
					const email = verifyToken.get(String(body.token))
					const account = email === undefined ? undefined : users.get(email)
					if (account === undefined) return send(400, { error_key: "email_verification_code_invalid" })
					account.verified = true
					const access = `verified-${account.email}`
					sessions.set(access, account.email)
					return send(200, { access_token: access })
				}
				if (url.pathname === "/v1/auth/reauth" && method === "POST") {
					const account = user()
					if (account === undefined) return send(401, { error: "unauthorized" })
					account.reauthed = true
					return send(200, { reauthenticated_until: 1 })
				}
				if (url.pathname === "/v1/auth/email/change/request" && method === "POST") {
					const account = user()
					if (account === undefined) return send(401, { error: "unauthorized" })
					if (!account.verified) return send(403, { error_key: "email_not_verified" })
					if (!account.reauthed) return send(403, { error_key: "account_reauth_required" })
					account.next = String(body.new_email)
					const mailed = `change-${sequence}`
					sequence += 1
					changeToken.set(mailed, sessions.get(token) ?? account.email)
					changeMail.set(account.email, `https://example.test/confirm-email-change?token=${encodeURIComponent(mailed)}`)
					return send(200, { success: true })
				}
				if (url.pathname === "/v1/auth/email/change/confirm" && method === "POST") {
					const email = changeToken.get(String(body.token))
					const account = email === undefined ? undefined : users.get(email)
					if (account === undefined) return send(400, { error_key: "email_change_code_invalid" })
					account.confirmed.add(String(body.confirmation_type))
					if (account.confirmed.size < 2) return send(200, { completed: false })
					account.email = account.next
					const access = `changed-${sequence}`
					sequence += 1
					sessions.set(access, email)
					return send(200, { access_token: access, completed: true })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await run({
			baseUrl: url,
			hooks: {
				resolveOutOfBand: async (req) => {
					if (req.kind.includes("verif")) return verifyMail.get(req.address) ?? null
					if (req.kind.includes("change")) return changeMail.get(req.address) ?? null
					return null
				},
			},
			nonce: "n1",
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "auth.confirmEmailChange")?.status).toBe("passed")
		const changed = [...users.values()].find((item) => item.email.includes("oat-mail-next-"))
		expect(changed?.confirmed.has("new")).toBe(true)
		expect(changed?.confirmed.has("old")).toBe(true)
	})

	it("updates newsletter preferences and unsubscribes with the mailed token", async () => {
		const state = new Map<string, { status: string; topics: Array<{ id: string; subscribed: boolean }> }>()
		const mail = new Map<string, string>()
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, newsletterDocument())
				if (url.pathname === "/v1/register" && method === "POST")
					return send(201, { access_token: `reg-${String(body.email)}` })
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "alpha" || token.startsWith("reg-"))
						return send(200, { email: "ada@example.test", first_name: "Ada" })
					return send(401, { error: "unauthorized" })
				}
				if (url.pathname === "/v1/newsletter/subscribe" && method === "POST") {
					const email = String(body.email)
					state.set(email, { status: "pending", topics: [{ id: "ntop_1", subscribed: false }] })
					mail.set(email, "https://example.test/newsletter/confirm?token=tok-nl")
					return send(202, { status: "accepted" })
				}
				if (url.pathname === "/v1/newsletter/preferences" && method === "GET") {
					const row = [...state.values()][0]
					if (url.searchParams.get("token") !== "tok-nl" || row === undefined)
						return send(401, { error_key: "newsletter_preference_invalid_token" })
					return send(200, row)
				}
				if (url.pathname === "/v1/newsletter/preferences" && method === "POST") {
					const row = [...state.values()][0]
					if (body.token !== "tok-nl" || row === undefined)
						return send(401, { error_key: "newsletter_preference_invalid_token" })
					const ids = new Set(Array.isArray(body.topic_ids) ? body.topic_ids.map(String) : [])
					row.topics = row.topics.map((topic) => ({ ...topic, subscribed: ids.has(topic.id) }))
					return send(200, { updated: true })
				}
				if (url.pathname === "/v1/newsletter/unsubscribe" && method === "POST") {
					const row = [...state.values()][0]
					if (body.token !== "tok-nl" || row === undefined)
						return send(401, { error_key: "newsletter_unsubscribe_invalid" })
					row.status = "unsubscribed"
					return send(200, { success: true })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await run({
			baseUrl: url,
			hooks: { resolveOutOfBand: async (req) => mail.get(req.address) ?? null },
			nonce: "n1",
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "newsletterPreference.get")?.status).toBe("passed")
		expect(result.scope.operations.find((op) => op.operationId === "newsletterPreference.update")?.status).toBe(
			"passed",
		)
		expect(result.scope.operations.find((op) => op.operationId === "newsletter.unsubscribe")?.status).toBe("passed")
		expect([...state.values()][0]?.topics[0]?.subscribed).toBe(true)
		expect([...state.values()].some((row) => row.status === "unsubscribed")).toBe(true)
	})

	it("grades the preference read when it shows the topic this call set", async () => {
		const state = new Map<string, { status: string; topics: Array<{ id: string; subscribed: boolean }> }>()
		const mail = new Map<string, string>()
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, newsletterDocument())
				if (url.pathname === "/v1/register" && method === "POST") return send(201, { access_token: "reg" })
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "alpha" || token === "reg") return send(200, { email: "ada@example.test", first_name: "Ada" })
					return send(401, { error: "unauthorized" })
				}
				if (url.pathname === "/v1/newsletter/subscribe" && method === "POST") {
					state.set(String(body.email), { status: "pending", topics: [{ id: "ntop_1", subscribed: false }] })
					mail.set(String(body.email), "https://example.test/newsletter/confirm?token=tok-nl")
					return send(202, { status: "accepted" })
				}
				if (url.pathname === "/v1/newsletter/preferences" && method === "GET") {
					const row = [...state.values()][0]
					if (url.searchParams.get("token") !== "tok-nl" || row === undefined)
						return send(401, { error_key: "newsletter_preference_invalid_token" })
					return send(200, row)
				}
				if (url.pathname === "/v1/newsletter/preferences" && method === "POST") {
					const row = [...state.values()][0]
					if (body.token !== "tok-nl" || row === undefined)
						return send(401, { error_key: "newsletter_preference_invalid_token" })
					const ids = new Set(Array.isArray(body.topic_ids) ? body.topic_ids.map(String) : [])
					row.topics = row.topics.map((topic) => ({ ...topic, subscribed: ids.has(topic.id) }))
					return send(200, { updated: true })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await run({
			baseUrl: url,
			hooks: { resolveOutOfBand: async (req) => mail.get(req.address) ?? null },
			nonce: "n1",
			ops: ["newsletterPreference.get"],
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "newsletterPreference.get")?.status).toBe("passed")
		expect([...state.values()][0]?.topics[0]?.subscribed).toBe(true)
	})

	it("fails the preference read when the body omits the topic this call set", async () => {
		const state = new Map<string, { mark: string; topics: Array<{ id: string; subscribed: boolean }> }>()
		const mail = new Map<string, string>()
		let reads = 0
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, newsletterDocument())
				if (url.pathname === "/v1/register" && method === "POST") return send(201, { access_token: "reg" })
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "alpha" || token === "reg") return send(200, { email: "ada@example.test", first_name: "Ada" })
					return send(401, { error: "unauthorized" })
				}
				if (url.pathname === "/v1/newsletter/subscribe" && method === "POST") {
					state.set(String(body.email), { mark: "before", topics: [{ id: "ntop_1", subscribed: false }] })
					mail.set(String(body.email), "https://example.test/newsletter/confirm?token=tok-nl")
					return send(202, { status: "accepted" })
				}
				if (url.pathname === "/v1/newsletter/preferences" && method === "GET") {
					const row = [...state.values()][0]
					if (url.searchParams.get("token") !== "tok-nl" || row === undefined)
						return send(401, { error_key: "newsletter_preference_invalid_token" })
					reads += 1
					if (reads === 1) return send(200, row)
					return send(200, { mark: row.mark })
				}
				if (url.pathname === "/v1/newsletter/preferences" && method === "POST") {
					const row = [...state.values()][0]
					if (body.token !== "tok-nl" || row === undefined)
						return send(401, { error_key: "newsletter_preference_invalid_token" })
					row.mark = "after"
					return send(200, { updated: true })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await run({
			baseUrl: url,
			hooks: { resolveOutOfBand: async (req) => mail.get(req.address) ?? null },
			nonce: "n1",
			ops: ["newsletterPreference.get"],
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "newsletterPreference.get")?.status).toBe("failed")
	})

	it("unsubscribes from the mailed token with a GET", async () => {
		const state = new Map<string, { status: string }>()
		const mail = new Map<string, string>()
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, unsubscribeGetDocument())
				if (url.pathname === "/v1/register" && method === "POST") return send(201, { access_token: "reg" })
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "alpha" || token === "reg") return send(200, { email: "ada@example.test", first_name: "Ada" })
					return send(401, { error: "unauthorized" })
				}
				if (url.pathname === "/v1/newsletter/subscribe" && method === "POST") {
					state.set(String(body.email), { status: "pending" })
					mail.set(String(body.email), "https://example.test/newsletter/confirm?token=tok-get")
					return send(202, { status: "accepted" })
				}
				if (url.pathname === "/v1/newsletter/preferences" && method === "GET") {
					const row = state.get([...mail.keys()][0] ?? "")
					if (url.searchParams.get("token") !== "tok-get" || row === undefined) return send(401, { error_key: "bad" })
					return send(200, row)
				}
				if (url.pathname === "/v1/newsletter/unsubscribe" && method === "GET") {
					const row = [...state.values()][0]
					if (url.searchParams.get("token") !== "tok-get" || row === undefined) return send(401, { error_key: "bad" })
					row.status = "unsubscribed"
					return send(200, { success: true })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await run({
			baseUrl: url,
			hooks: { resolveOutOfBand: async (req) => mail.get(req.address) ?? null },
			nonce: "n1",
			ops: ["newsletter.unsubscribeGet"],
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "newsletter.unsubscribeGet")?.status).toBe("passed")
		expect([...state.values()][0]?.status).toBe("unsubscribed")
	})

	it("accepts a collaborator invite, resends it, and declines another", async () => {
		const invites: Array<Record<string, unknown>> = []
		const mail = new Map<string, string>()
		let invitedAt = 1
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
				const token = typeof req.headers.authorization === "string" ? req.headers.authorization.slice(7).trim() : ""
				const send = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" })
					res.end(JSON.stringify(payload))
				}
				const emailOf = () => (token.startsWith("reg-") ? token.slice(4) : "")
				if (url.pathname === "/openapi.json" && method === "GET") return send(200, inviteDocument())
				if (url.pathname === "/v1/register" && method === "POST")
					return send(201, { access_token: `reg-${String(body.email)}` })
				if (url.pathname === "/v1/me" && method === "GET") {
					if (token === "owner" || token.startsWith("reg-"))
						return send(200, { email: token === "owner" ? "owner@example.test" : emailOf(), first_name: "Ada" })
					return send(401, { error: "unauthorized" })
				}
				if (url.pathname === "/v1/projects/prj_1/collaborators" && method === "POST") {
					invitedAt += 1
					invites.push({
						id: "mem_1",
						invite_email: body.email,
						invited_at: invitedAt,
						project_id: "prj_1",
						sid: 1,
						type: "project",
					})
					mail.set(String(body.email), "project-token")
					return send(201, { id: "mem_1" })
				}
				if (url.pathname === "/v1/projects/prj_1/members" && method === "GET") {
					return send(200, { members: invites.filter((item) => item.type === "project") })
				}
				if (url.pathname === "/v1/projects/prj_1/collaborators/mem_1/resend" && method === "POST") {
					const row = invites.find((item) => item.id === "mem_1")
					if (row) row.invited_at = (row.invited_at as number) + 10
					mail.set(String(row?.invite_email), "project-token-2")
					return send(200, { id: "mem_1" })
				}
				if (url.pathname === "/v1/organizations/org_1/members" && method === "POST") {
					invites.push({ id: "mem_org", invite_email: body.invite_email, sid: 2, type: "org" })
					return send(201, { id: "mem_org" })
				}
				if (url.pathname === "/v1/invites" && method === "GET") {
					return send(200, { invites: invites.filter((item) => item.invite_email === emailOf()) })
				}
				if (url.pathname === "/v1/projects/collaborators/accept" && method === "POST") {
					if (body.token !== "project-token-2") return send(410, { error_key: "invite_expired" })
					const index = invites.findIndex((item) => item.id === "mem_1")
					if (index >= 0) invites.splice(index, 1)
					return send(200, { access_token: "accepted", id: "mem_1", project_id: "prj_1" })
				}
				if (url.pathname === "/v1/invites/mem_org/decline" && method === "POST") {
					const index = invites.findIndex((item) => item.id === "mem_org")
					if (index >= 0) invites.splice(index, 1)
					return send(200, { id: "mem_org" })
				}
				return send(404, { error: "missing" })
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await run({
			baseUrl: url,
			hooks: {
				resolveOutOfBand: async (req) => (req.kind === "project-invite" ? (mail.get(req.address) ?? null) : null),
			},
			nonce: "n1",
			principals: [
				{
					headers: { authorization: "Bearer owner" },
					id: "owner",
					roots: { organization_id: "org_1", project_id: "prj_1" },
				},
			],
			ops: ["project.acceptCollaboratorInvite", "project.resendCollaboratorInvite", "invite.decline"],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "project.acceptCollaboratorInvite")?.status).toBe(
			"passed",
		)
		expect(result.scope.operations.find((op) => op.operationId === "project.resendCollaboratorInvite")?.status).toBe(
			"passed",
		)
		expect(result.scope.operations.find((op) => op.operationId === "invite.decline")?.status).toBe("passed")
	})

	it("reports a token whose session cannot read the profile", async () => {
		const { box, url } = await serve(false)
		const result = await runMail(url, box)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.summary ?? finding.check)).toContain(
			"the follow-up did not show the mailed change",
		)
		expect(result.scope.operations.find((op) => op.operationId === "auth.loginMagicLinkVerify")?.status).toBe("failed")
	})
})
