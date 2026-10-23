import { afterEach, describe, expect, it } from "vitest"
import type { OutOfBandRequest } from "../../src/config/types/hooks.ts"
import type { SecurityConfig } from "../../src/config/types/security.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Listeners, readJson, reply, serve } from "../support/effects-fixtures.ts"

/*
 * A sign-in whose secret arrives out of band: the API mails a one-time code, `resolveOutOfBand`
 * fetches it from the inbox, and the login spends it for a token whose claims name the principal's
 * organization. The reference delivers nothing out of band, so a small sign-in-by-code API stands in.
 */

const listeners = new Listeners()
afterEach(() => listeners.closeAll())

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const OK = { "200": { ...json({ type: "object" }), description: "ok" } }

const SPEC = {
	components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
	info: { title: "code sign-in", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/auth/code": { post: { operationId: "auth.sendCode", responses: OK, security: [] } },
		"/v1/auth/verify": { post: { operationId: "auth.verify", responses: OK, security: [] } },
		"/v1/orgs/{org_id}/items": {
			get: {
				operationId: "items.list",
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				responses: { ...OK, "401": { description: "no session" }, "403": { description: "another org" } },
			},
		},
	},
	security: [{ bearer: [] }],
} as unknown as OpenApiDocument

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

function unsignedJwt(claims: Record<string, unknown>): string {
	return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.sig`
}

/** The API's inbox by address, the token it issued, and each item list's path and bearer. */
interface World {
	inbox: Map<string, string>
	token: string
	reads: Array<{ path: string; bearer: string }>
}

/* Mails a code to whoever asks, trades a matching code for a token, and lists org_7's items to that token alone. */
async function codeApi(): Promise<{ url: string; world: World }> {
	const world: World = { inbox: new Map(), reads: [], token: unsignedJwt({ org_id: "org_7", sub: "u_1" }) }
	const server = await serve(listeners, SPEC, [
		async ({ req, res, url }) => {
			if (url.pathname !== "/v1/auth/code") return false
			const { email } = await readJson<{ email: string }>(req)
			world.inbox.set(email, `code-${world.inbox.size + 1}`)
			return reply(res, 200, { sent: true })
		},
		async ({ req, res, url }) => {
			if (url.pathname !== "/v1/auth/verify") return false
			const { code, email } = await readJson<{ code?: string; email?: string }>(req)
			const known = email !== undefined && code !== undefined && world.inbox.get(email) === code
			return reply(res, known ? 200 : 401, known ? { access_token: world.token } : { error: "bad code" })
		},
		({ req, res, url }) => {
			const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "")
			world.reads.push({ bearer, path: url.pathname })
			if (bearer !== world.token) return reply(res, 401, { error: "unauthorized" })
			return reply(res, url.pathname === "/v1/orgs/org_7/items" ? 200 : 403, { items: [] })
		},
	])
	return { url: server.url, world }
}

/* Signs in by a mailed code; the token's claims bind the organization. */
const BY_CODE: SecurityConfig = {
	bearer: {
		login: {
			claims: { "scope.org_id": "org_id", tenant: "org_id" },
			from: "$.access_token",
			steps: [
				{ body: { email: "{principal.email}" }, operationId: "auth.sendCode" },
				{ outOfBand: { address: "{principal.email}", as: "code", kind: "sign-in-code" } },
				{ body: { code: "{code}", email: "{principal.email}" }, operationId: "auth.verify" },
			],
		},
	},
}

async function signInByCode(resolve: (request: OutOfBandRequest, world: World) => string | null) {
	const { url, world } = await codeApi()
	const asked: OutOfBandRequest[] = []
	const result = await run({
		baseUrl: url,
		hooks: {
			resolveOutOfBand: (request) => {
				asked.push(request)
				return Promise.resolve(resolve(request, world))
			},
		},
		outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
		principals: { alpha: { email: "alpha@example.test" } },
		security: BY_CODE,
		seed: 1,
		spec: `${url}/v1/openapi/spec`,
	})
	return { asked, result, world }
}

const fromInbox = (request: OutOfBandRequest, api: World) => api.inbox.get(request.address) ?? null

describe("a credential delivered out of band", () => {
	it("signs in with the mailed code and reaches the organization its token's claims name", async () => {
		const { asked, result, world } = await signInByCode(fromInbox)
		expect(asked[0]).toMatchObject({ address: "alpha@example.test", attempt: 1, kind: "sign-in-code" })
		expect(asked[0]?.since).toEqual(expect.any(Number))
		expect(result.scope.operations.find((op) => op.operationId === "items.list")?.status).toBe("passed")
		expect(world.reads).toContainEqual({ bearer: world.token, path: "/v1/orgs/org_7/items" })
		expect(result.principals.find((principal) => principal.id === "alpha")).toMatchObject({
			credentials: [{ scheme: "bearer" }],
			scope: { org_id: "org_7" },
			tenant: "org_7",
		})
	})

	it("blocks the principal, naming the code that never arrived, and sends it nowhere", async () => {
		const { asked, result, world } = await signInByCode(() => null)
		expect(asked.map((request) => request.attempt)).toEqual([1, 2])
		expect(world.reads.filter((read) => read.bearer === world.token)).toEqual([])
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				check: "auth.blocked",
				detail: expect.stringContaining('no "sign-in-code" value arrived for alpha@example.test after 2 attempts'),
				entity: "alpha",
				verdict: "BLOCKED",
			}),
		)
		expect(result.scope.operations.find((op) => op.operationId === "items.list")?.status).toBe("untested")
	})
})
