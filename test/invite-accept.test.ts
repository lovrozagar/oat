import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const MEMBER = {
	properties: { email: { format: "email", type: "string" }, id: { type: "string" } },
	required: ["id", "email"],
	type: "object",
}

function inviteSpec(accept: "body" | "path", revoke: "body" | "path" = "path"): OpenApiDocument {
	const acceptPath =
		accept === "body"
			? {
					"/v1/invites/accept": {
						post: {
							operationId: "invite.accept",
							requestBody: {
								content: {
									"application/json": {
										schema: {
											properties: { token: { type: "string" } },
											required: ["token"],
											type: "object",
										},
									},
								},
								required: true,
							},
							responses: { "200": { description: "ok" } },
							"x-entity": { action: "action", identity: "id", name: "member" },
						},
					},
				}
			: {
					"/v1/invites/{token}": {
						post: {
							operationId: "invite.accept",
							parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
							responses: { "200": { description: "ok" } },
							"x-entity": { action: "action", identity: "id", name: "member" },
						},
					},
				}
	const revokePath =
		revoke === "body"
			? {
					"/v1/invites/revoke": {
						post: {
							operationId: "invite.revoke",
							requestBody: {
								content: {
									"application/json": {
										schema: {
											properties: { grant_id: { type: "string" } },
											required: ["grant_id"],
											type: "object",
										},
									},
								},
								required: true,
							},
							responses: { "200": { description: "ok" } },
							"x-entity": { action: "action", identity: "id", name: "member" },
						},
					},
				}
			: {
					"/v1/orgs/{org_id}/grants/{grant_id}": {
						delete: {
							operationId: "invite.revoke",
							parameters: [
								{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
								{ in: "path", name: "grant_id", required: true, schema: { type: "string" } },
							],
							responses: { "200": { description: "ok" } },
							"x-entity": { action: "action", identity: "id", name: "member" },
						},
					},
				}

	return {
		info: { title: "invite-accept", version: "1" },
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
									schema: {
										properties: { members: { items: MEMBER, type: "array" } },
										required: ["members"],
										type: "object",
									},
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
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { invite_email: { format: "email", type: "string" } },
									required: ["invite_email"],
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
										properties: { grant_id: { type: "string" }, token: { type: "string" } },
										required: ["grant_id", "token"],
										type: "object",
									},
								},
							},
							description: "invited",
						},
					},
					"x-entity": { action: "create", identity: "id", name: "member" },
					"x-invite": {
						accept: "invite.accept",
						grantPointer: "$.grant_id",
						granteeField: "invite_email",
						invite: "org.inviteMember",
						revoke: "invite.revoke",
						tokenPointer: "$.token",
					},
				},
			},
			"/v1/orgs/{org_id}/members/{member_id}": {
				get: {
					operationId: "member.read",
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "member_id", required: true, schema: { type: "string" } },
					],
					responses: { "200": { content: { "application/json": { schema: MEMBER } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "member" },
				},
			},
			...acceptPath,
			...revokePath,
		},
	} as OpenApiDocument
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

const principals = [
	{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { org_id: "org_1" } },
	{
		headers: { authorization: "Bearer b" },
		id: "beta",
		inviteAs: "beta@x.test",
		roots: { org_id: "org_2" },
	},
]

describe("invite accept request", () => {
	it("sends the documented JSON { token } body with application/json", async () => {
		const spec = inviteSpec("body")
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
				if (url.pathname === "/v1/orgs/org_1/members" && method === "GET") return send(res, 200, { members: [] })
				if (url.pathname === "/v1/orgs/org_1/members" && method === "POST") {
					return send(res, 201, { grant_id: "g1", token: "tok-from-invite" })
				}
				if (url.pathname === "/v1/invites/accept" && method === "POST") {
					const type = req.headers["content-type"] ?? ""
					const body = await readJson(req)
					if (!type.includes("application/json")) return send(res, 415, { error: "unsupported_media_type" })
					if (body === null || typeof body !== "object" || (body as { token?: unknown }).token !== "tok-from-invite") {
						return send(res, 400, { error: "missing_token" })
					}
					return send(res, 200, { ok: true })
				}
				if (url.pathname === "/v1/orgs/org_1/grants/g1" && method === "DELETE") return send(res, 200, { ok: true })
				if (/^\/v1\/orgs\/org_1\/members\/[^/]+$/.test(url.pathname) && method === "GET") return send(res, 404)
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		closers.push(server.close)

		const result = await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const accept = result.client.transcript.find(
			(e) => e.method === "POST" && new URL(e.url).pathname === "/v1/invites/accept",
		)
		expect(accept).toBeDefined()
		expect(accept?.status).toBe(200)
		expect(accept?.requestHeaders["content-type"]).toMatch(/application\/json/)
		expect(accept?.requestBody).toEqual({ token: "tok-from-invite" })
		expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
	})

	it("keeps a path-only accept on the path and does not invent a body", async () => {
		const spec = inviteSpec("path")
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
				if (url.pathname === "/v1/orgs/org_1/members" && method === "GET") return send(res, 200, { members: [] })
				if (url.pathname === "/v1/orgs/org_1/members" && method === "POST") {
					return send(res, 201, { grant_id: "g1", token: "tok-from-invite" })
				}
				if (url.pathname === "/v1/invites/tok-from-invite" && method === "POST") {
					const chunks: Buffer[] = []
					for await (const chunk of req) chunks.push(chunk as Buffer)
					if (Buffer.concat(chunks).length > 0) return send(res, 400, { error: "unexpected_body" })
					return send(res, 200, { ok: true })
				}
				if (url.pathname === "/v1/orgs/org_1/grants/g1" && method === "DELETE") return send(res, 200, { ok: true })
				if (/^\/v1\/orgs\/org_1\/members\/[^/]+$/.test(url.pathname) && method === "GET") return send(res, 404)
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		closers.push(server.close)

		const result = await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const accept = result.client.transcript.find(
			(e) => e.method === "POST" && new URL(e.url).pathname === "/v1/invites/tok-from-invite",
		)
		expect(accept).toBeDefined()
		expect(accept?.status).toBe(200)
		expect(accept?.requestBody).toBeUndefined()
		expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
	})

	it("sends the documented JSON revoke body when revoke declares one", async () => {
		const spec = inviteSpec("body", "body")
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
				if (url.pathname === "/v1/orgs/org_1/members" && method === "GET") return send(res, 200, { members: [] })
				if (url.pathname === "/v1/orgs/org_1/members" && method === "POST") {
					return send(res, 201, { grant_id: "g1", token: "tok-from-invite" })
				}
				if (url.pathname === "/v1/invites/accept" && method === "POST") {
					const body = await readJson(req)
					if ((body as { token?: unknown })?.token !== "tok-from-invite") return send(res, 400)
					return send(res, 200, { ok: true })
				}
				if (url.pathname === "/v1/invites/revoke" && method === "POST") {
					const type = req.headers["content-type"] ?? ""
					const body = await readJson(req)
					if (!type.includes("application/json")) return send(res, 415)
					if ((body as { grant_id?: unknown })?.grant_id !== "g1") return send(res, 400)
					return send(res, 200, { ok: true })
				}
				if (/^\/v1\/orgs\/org_1\/members\/[^/]+$/.test(url.pathname) && method === "GET") return send(res, 404)
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		closers.push(server.close)

		const result = await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const revoke = result.client.transcript.find(
			(e) => e.method === "POST" && new URL(e.url).pathname === "/v1/invites/revoke",
		)
		expect(revoke).toBeDefined()
		expect(revoke?.status).toBe(200)
		expect(revoke?.requestHeaders["content-type"]).toMatch(/application\/json/)
		expect(revoke?.requestBody).toEqual({ grant_id: "g1" })
		expect(new URL(revoke?.url ?? "http://x").pathname).toBe("/v1/invites/revoke")
	})

	it("accepts with the mailed token when tokenFrom is outOfBand", async () => {
		const spec = inviteSpec("body")
		const invite = spec.paths["/v1/orgs/{org_id}/members"]?.post as Record<string, unknown>
		invite["x-invite"] = {
			...(invite["x-invite"] as Record<string, unknown>),
			tokenFrom: "outOfBand",
			tokenKind: "org-invite",
		}
		const kinds: string[] = []
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
				if (url.pathname === "/v1/orgs/org_1/members" && method === "GET") return send(res, 200, { members: [] })
				if (url.pathname === "/v1/orgs/org_1/members" && method === "POST") {
					return send(res, 201, { grant_id: "g1", token: "tok-from-json-ignored" })
				}
				if (url.pathname === "/v1/invites/accept" && method === "POST") {
					const body = await readJson(req)
					if ((body as { token?: unknown })?.token !== "tok-from-mail") return send(res, 400, { error: "wrong" })
					return send(res, 200, { ok: true })
				}
				if (url.pathname === "/v1/orgs/org_1/grants/g1" && method === "DELETE") return send(res, 200, { ok: true })
				if (/^\/v1\/orgs\/org_1\/members\/[^/]+$/.test(url.pathname) && method === "GET") return send(res, 404)
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		closers.push(server.close)

		const result = await run({
			baseUrl: server.url,
			hooks: {
				resolveOutOfBand: async ({ address, kind }) => {
					kinds.push(kind)
					expect(address).toBe("beta@x.test")
					return "tok-from-mail"
				},
			},
			only: ["member"],
			outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
			principals,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const accept = result.client.transcript.find(
			(e) => e.method === "POST" && new URL(e.url).pathname === "/v1/invites/accept",
		)
		expect(accept?.requestBody).toEqual({ token: "tok-from-mail" })
		expect(kinds).toContain("org-invite")
		expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
	})
})
