import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { run } from "../src/runtime/run.ts"

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

const ALPHA = "alpha@example.test"
const BETA = "beta@example.test"
const ORG = "org_oat_admin_1"

function document(): OpenApiDocument {
	const admin = { responses: { "200": { description: "ok" } }, "x-admin": true }
	return {
		info: { title: "admin", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/admin/impersonations": { post: { ...admin, operationId: "admin.startImpersonation" } },
			"/v1/admin/impersonations/{id}/end": { post: { ...admin, operationId: "admin.endImpersonation" } },
			"/v1/admin/organizations/{id}": { get: { ...admin, operationId: "admin.retrieveOrganization" } },
			"/v1/admin/public-profiles/{id}/hide": { post: { ...admin, operationId: "admin.hidePublicProfile" } },
			"/v1/admin/public-profiles/{id}/unhide": { post: { ...admin, operationId: "admin.unhidePublicProfile" } },
			"/v1/admin/users": {
				get: {
					...admin,
					operationId: "admin.searchUsers",
					parameters: [{ in: "query", name: "q", required: true, schema: { type: "string" } }],
				},
			},
			"/v1/admin/users/{id}": { get: { ...admin, operationId: "admin.retrieveUser" } },
			"/v1/admin/users/{id}/public-profile": { get: { ...admin, operationId: "admin.retrieveUserPublicProfile" } },
			"/v1/auth/refresh": { post: { operationId: "auth.refreshToken", responses: { "200": { description: "ok" } } } },
			"/v1/auth/register": {
				post: { operationId: "auth.registerWithEmail", responses: { "200": { description: "ok" } } },
			},
			"/v1/public-profiles/me": {
				get: { operationId: "publicProfile.getMe", responses: { "200": { description: "ok" } } },
				post: { operationId: "publicProfile.createMe", responses: { "200": { description: "ok" } } },
			},
			"/v1/public-profiles/{handle}": {
				get: { operationId: "publicProfile.getByHandle", responses: { "200": { description: "ok" } } },
			},
		},
	} as OpenApiDocument
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler)
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo
			open.push({ close: () => new Promise((done) => server.close(() => done())) })
			resolve(`http://127.0.0.1:${address.port}`)
		})
	})
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

function principal(email: string, refresh: boolean) {
	return {
		auth: {
			credentialFrom: "$.access_token",
			...(refresh
				? {
						refresh: {
							steps: [
								{
									body: { refresh_token: "{refreshToken}" },
									operationId: "auth.refreshToken",
									saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
								},
							],
						},
					}
				: {}),
			steps: [
				{
					body: { email, password: "secret-pass" },
					operationId: "auth.registerWithEmail",
					saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
				},
			],
		},
		id: email.startsWith("alpha") ? "alpha" : "beta",
		...(email.startsWith("alpha") ? { roots: { organization_id: ORG } } : {}),
	}
}

describe("platform admin", () => {
	it("grants, refreshes, and reads the other user before ending impersonation", async () => {
		const order: string[] = []
		let hidden = false
		let ended = false
		let granted = false
		const base = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi.json") {
				json(res, 200, document())
				return
			}
			order.push(`${req.method} ${url.pathname}`)
			if (url.pathname === "/v1/auth/register") {
				json(res, 200, { access_token: "issued", refresh_token: "refresh-1" })
				return
			}
			if (url.pathname === "/v1/auth/refresh") {
				json(res, 200, { access_token: "refreshed", refresh_token: "refresh-2" })
				return
			}
			if (url.pathname === "/v1/public-profiles/me" && req.method === "POST") {
				json(res, 200, { handle: "beta", id: "pfl_oat_admin_1" })
				return
			}
			if (url.pathname === "/v1/admin/users") {
				const users = url.searchParams.get("q") === BETA ? [{ email: BETA, id: "usr_oat_beta_1" }] : []
				json(res, 200, { users })
				return
			}
			if (url.pathname === "/v1/admin/users/usr_oat_beta_1") {
				json(res, 200, {
					impersonations: ended ? [{ ended_at: 10, id: "imp_oat_admin_1" }] : [],
					user: { email: BETA, id: "usr_oat_beta_1" },
				})
				return
			}
			if (url.pathname === `/v1/admin/organizations/${ORG}`) {
				json(res, 200, { organization: { id: ORG } })
				return
			}
			if (url.pathname.endsWith("/public-profile")) {
				json(res, 200, { handle: "beta", id: "pfl_oat_admin_1" })
				return
			}
			if (url.pathname === "/v1/admin/impersonations") {
				json(res, 200, {
					impersonation_id: "imp_oat_admin_1",
					user: { email: BETA, id: "usr_oat_beta_1" },
				})
				return
			}
			if (url.pathname.endsWith("/end")) {
				ended = true
				json(res, 200, { success: true })
				return
			}
			if (url.pathname.endsWith("/hide")) {
				hidden = true
				json(res, 200, { id: "pfl_oat_admin_1" })
				return
			}
			if (url.pathname.endsWith("/unhide")) {
				hidden = false
				json(res, 200, { id: "pfl_oat_admin_1" })
				return
			}
			if (url.pathname === "/v1/public-profiles/beta") {
				if (hidden) {
					json(res, 404, { error_key: "public_profile_not_found" })
					return
				}
				json(res, 200, { handle: "beta" })
				return
			}
			json(res, 500, { error: url.pathname })
		})
		const result = await run({
			baseUrl: base,
			hooks: {
				preparePlatformAdmin: async () => {
					granted = true
					return true
				},
			},
			ops: [
				"admin.searchUsers",
				"admin.retrieveUser",
				"admin.retrieveOrganization",
				"admin.retrieveUserPublicProfile",
				"admin.startImpersonation",
				"admin.endImpersonation",
				"admin.hidePublicProfile",
				"admin.unhidePublicProfile",
			],
			principals: [principal(ALPHA, true), principal(BETA, false)],
			seed: 1,
			spec: `${base}/openapi.json`,
		})
		const endAt = order.findIndex((line) => line.endsWith("/end"))
		const hideAt = order.findIndex((line) => line.endsWith("/hide"))
		expect(granted).toBe(true)
		expect(order.some((line) => line === "POST /v1/auth/refresh")).toBe(true)
		expect(endAt).toBeGreaterThan(-1)
		expect(hideAt).toBeGreaterThan(endAt)
		for (const id of [
			"admin.searchUsers",
			"admin.retrieveUser",
			"admin.retrieveOrganization",
			"admin.retrieveUserPublicProfile",
			"admin.startImpersonation",
			"admin.endImpersonation",
			"admin.hidePublicProfile",
			"admin.unhidePublicProfile",
		]) {
			expect(result.scope.operations.find((op) => op.operationId === id)?.status, id).toBe("passed")
		}
	})
})
