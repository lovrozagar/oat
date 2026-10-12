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

const EMAIL = "caller@example.test"
const PASSWORD = "secret-pass"

function document(): OpenApiDocument {
	return {
		info: { title: "file", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/auth/data-export": {
				get: {
					operationId: "auth.dataExportStatus",
					responses: { "200": { description: "ok" } },
				},
				post: {
					operationId: "auth.requestDataExport",
					responses: { "200": { description: "ok" }, "403": { description: "reauth" } },
					"x-invalidate": ["GET /v1/auth/data-export"],
				},
			},
			"/v1/auth/data-export/download": {
				get: {
					operationId: "auth.downloadDataExport",
					responses: { "200": { description: "ok" } },
					"x-file": { pollIntervalMs: 20, ready: "ready", timeoutMs: 3000, until: "$.export.status" },
				},
			},
			"/v1/auth/register": {
				post: {
					operationId: "auth.registerWithEmail",
					responses: { "200": { description: "ok" } },
				},
			},
			"/v1/auth/reauth": {
				post: {
					operationId: "auth.reauthenticate",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { password: { type: "string" } }, type: "object" },
							},
						},
					},
					responses: { "200": { description: "ok" } },
				},
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

describe("downloaded files", () => {
	it("passes when the download contains the caller address", async () => {
		let reauthed = false
		let polls = 0
		const base = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi.json") {
				json(res, 200, document())
				return
			}
			if (url.pathname === "/v1/auth/register") {
				json(res, 200, { access_token: "tok", access_token_expires_in: 3600 })
				return
			}
			if (url.pathname === "/v1/auth/reauth") {
				reauthed = true
				json(res, 200, { reauthenticated_until: 1 })
				return
			}
			if (req.method === "POST" && url.pathname === "/v1/auth/data-export") {
				if (!reauthed) {
					json(res, 403, { error_key: "account_reauth_required" })
					return
				}
				json(res, 200, { export: { id: "udex_oat_file_1", status: "running" } })
				return
			}
			if (url.pathname === "/v1/auth/data-export") {
				polls += 1
				json(res, 200, { export: { status: polls < 2 ? "running" : "ready" } })
				return
			}
			json(res, 200, { format: "anyrow.personal-data-export", profile: { email: EMAIL }, version: 1 })
		})
		const result = await run({
			baseUrl: base,
			ops: ["auth.requestDataExport", "auth.downloadDataExport"],
			principals: [
				{
					auth: {
						credentialFrom: "$.access_token",
						steps: [
							{
								body: { email: EMAIL, password: PASSWORD },
								operationId: "auth.registerWithEmail",
								saveAs: { credential: "$.access_token" },
							},
						],
					},
					id: "alpha",
				},
			],
			seed: 1,
			spec: `${base}/openapi.json`,
		})
		expect(reauthed).toBe(true)
		expect(result.scope.operations.find((op) => op.operationId === "auth.downloadDataExport")?.status).toBe("passed")
		expect(result.scope.operations.find((op) => op.operationId === "auth.requestDataExport")?.status).toBe("passed")
	})

	it("fails when the download omits the caller address", async () => {
		const base = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi.json") {
				json(res, 200, document())
				return
			}
			if (url.pathname === "/v1/auth/register") {
				json(res, 200, { access_token: "tok", access_token_expires_in: 3600 })
				return
			}
			if (req.method === "POST" && url.pathname === "/v1/auth/data-export") {
				json(res, 200, { export: { status: "running" } })
				return
			}
			if (url.pathname === "/v1/auth/data-export") {
				json(res, 200, { export: { status: "ready" } })
				return
			}
			json(res, 200, { format: "anyrow.personal-data-export", version: 1 })
		})
		const result = await run({
			baseUrl: base,
			ops: ["auth.downloadDataExport"],
			principals: [
				{
					auth: {
						credentialFrom: "$.access_token",
						steps: [
							{
								body: { email: EMAIL, password: PASSWORD },
								operationId: "auth.registerWithEmail",
								saveAs: { credential: "$.access_token" },
							},
						],
					},
					id: "alpha",
				},
			],
			seed: 1,
			spec: `${base}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "auth.downloadDataExport")?.status).toBe("failed")
	})
})
