import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../config/types/security.ts"
import type { CredentialPorts } from "../credentials/ports.ts"
import { createStore } from "../credentials/store.ts"
import { Redactor } from "../security/redact.ts"
import { buildModel } from "../spec/graph/build.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { json, transport } from "./__fixtures__/transport.ts"
import { Client } from "./client.ts"
import { type Resolution, UnsatisfiedSecurity } from "./credential-source.ts"
import { createCredentialSource } from "./credentials.ts"

/* A principal whose renewal fails: the refusal stands, and nothing more is sent for it. */

/* A backend that refuses every request, as an expired session would be. */
function expired(): { fetch: typeof fetch; hits: () => number } {
	const wire = transport(() => json({}, 401))
	return { fetch: wire.fetch, hits: () => wire.sent.length }
}

/* One secured operation the backend answers 401. */
const EXPIRED_DOC = {
	components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } },
	info: { title: "expired", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/expired": {
			get: { operationId: "expired.get", responses: { "401": { description: "expired" } }, security: [{ jwt: [] }] },
		},
	},
} as unknown as OpenApiDocument

/* A jwt with a login and a refresh of its own. */
const RENEWABLE: SecurityConfig = {
	jwt: {
		login: { from: "$.token", steps: [{ operationId: "auth.login" }] },
		refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
	},
}

const unexpected = (what: string) => Promise.reject(new Error(`unexpected ${what}`))

/* Ports whose first login issues a token, and whose every later step (the refresh, the fallback login) is refused. */
function renewalRefused(steps: string[]): CredentialPorts {
	return {
		operations: { call: () => unexpected("call") },
		steps: {
			run: async (run) => {
				const step = run.map((one) => ("operationId" in one ? one.operationId : "?")).join(",")
				steps.push(step)
				if (steps.length > 1) throw new Error(`${step} answered 401`)
				return { answer: { body: { token: "token-1" }, cookies: {}, headers: {}, status: 200 }, scope: {} }
			},
		},
		secrets: { register: () => undefined },
		tokens: { post: () => unexpected("post") },
	}
}

describe("a principal whose renewal fails", () => {
	it("answers the refusal as it is when its renewal fails, and sends nothing more", async () => {
		let resolved = 0
		const sending: Resolution = {
			block: () => undefined,
			kind: "sends",
			principal: "alpha",
			refresh: async () => ({
				kind: "blocked",
				reason: "alpha's refresh for bearer failed: refresh endpoint said 500",
			}),
			schemes: ["bearer"],
			secrets: { cookies: [], headers: ["authorization"], query: [], values: ["Bearer stale"] },
			sends: { bearer: { cookies: {}, headers: { authorization: "Bearer stale" }, query: {} } },
			sentValues: { bearer: "stale" },
		}
		const backend = expired()
		const client = new Client({
			baseUrl: "http://api.test",
			credentials: {
				resolve: async () => {
					resolved += 1
					return sending
				},
			},
			network: { fetchImpl: backend.fetch },
			redactor: new Redactor(),
		})
		const refused = await client.get("/expired", { as: { principal: "alpha" } })
		expect(refused.status).toBe(401)
		expect([backend.hits(), resolved]).toEqual([1, 1])
	})

	it("blocks its principal through the real store: the next request is refused before it is sent", async () => {
		const steps: string[] = []
		const model = buildModel(EXPIRED_DOC)
		const principals = { alpha: {} }
		const store = createStore({ ports: renewalRefused(steps), principals, schemes: model.schemes, security: RENEWABLE })
		const backend = expired()
		const client = new Client({
			baseUrl: "http://api.test",
			credentials: createCredentialSource({ model, principals, security: RENEWABLE, store }),
			network: { fetchImpl: backend.fetch },
			operationResolver: (method, path) =>
				method === "GET" && path === "/expired" ? { operationId: "expired.get", template: path } : null,
			redactor: new Redactor(),
		})
		expect((await client.get("/expired", { as: { principal: "alpha" } })).status).toBe(401)
		expect([backend.hits(), steps]).toEqual([1, ["auth.login", "auth.refresh", "auth.login"]])
		const next = client.get("/expired", { as: { principal: "alpha" } })
		await expect(next).rejects.toBeInstanceOf(UnsatisfiedSecurity)
		await expect(next).rejects.toMatchObject({
			kind: "blocked",
			reason:
				"renewal for alpha/jwt: the refresh failed (auth.refresh answered 401), then acquiring afresh failed (auth.login answered 401)",
		})
		expect(backend.hits()).toBe(1)
	})
})
