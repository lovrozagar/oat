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
