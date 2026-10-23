import { afterEach, describe, expect, it } from "vitest"
import type { CredentialPrincipal } from "../../src/config/types/hooks.ts"
import type { PrincipalEntry, PrincipalsConfig, SecurityConfig } from "../../src/config/types/security.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"
import { run, type RunOptions, type RunResult } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Listeners, reply, serve } from "../support/effects-fixtures.ts"
import { referenceToken } from "../support/reference-auth.ts"
import { sentTo, type WireLog, wireLog } from "../support/wire-log.ts"

/*
 * Each recipe kind, driven through a run: the credential it produces is the one the graded
 * operation carries, and the run's principals name the scheme it was held for. login, mint, static
 * and hook run against the reference; it has no OAuth 2 token URL, so both oauth2 grants run against
 * a small token server.
 */

const listeners = new Listeners()
let reference: ReferenceServer | undefined
afterEach(async () => {
	await listeners.closeAll()
	await reference?.close()
	reference = undefined
})

interface Ran {
	result: RunResult
	log: WireLog
	url: string
}

/* One targeted run against a fresh reference, every request logged as it left. */
async function againstReference(options: Partial<RunOptions> & { ops: string[] }): Promise<Ran> {
	reference = await createMemoryServer()
	const { url } = reference
	const log = wireLog()
	const result = await run({
		baseUrl: url,
		network: { fetch: log.fetch },
		principals: { alpha: { key: "key_alpha" } },
		seed: 1,
		spec: `${url}/v1/openapi/spec`,
		...options,
	})
	return { log, result, url }
}

const status = (result: RunResult, operationId: string) =>
	result.scope.operations.find((op) => op.operationId === operationId)?.status

/* The schemes alpha held when the run ended. */
const heldSchemes = (result: RunResult) =>
	result.principals.find((principal) => principal.id === "alpha")?.credentials.map((held) => held.scheme)

/* Requests the run sent as alpha for `operationId`, with the schemes each carried, that the server took. */
const accepted = (result: RunResult, operationId: string) =>
	result.client.transcript
		.filter((exchange) => exchange.operationId === operationId && exchange.principal === "alpha")
		.filter((exchange) => exchange.status < 300)
		.map((exchange) => exchange.schemes)

describe("a login recipe", () => {
	it("signs in by email and password at auth.login and sends the token it answered", async () => {
		const { log, result } = await againstReference({
			ops: ["profile.get"],
			principals: { alpha: { email: "alpha@reference.test", password: "alpha-password" } },
			security: {
				jwt: {
					login: {
						from: "$.access_token",
						steps: [
							{ body: { email: "{principal.email}", password: "{principal.password}" }, operationId: "auth.login" },
						],
					},
				},
			},
		})
		const login = log.entries.filter((entry) => entry.path === "/v1/auth/login" && entry.status === 200)
		expect(login).toHaveLength(1)
		const issued = (JSON.parse(login[0]?.answer ?? "{}") as { access_token: string }).access_token
		expect(status(result, "profile.get")).toBe("passed")
		expect(sentTo(log, "/v1/me")).toContain(`Bearer ${issued}`)
		expect(accepted(result, "profile.get")).toContainEqual(["jwt"])
		expect(heldSchemes(result)).toEqual(["jwt"])
	})
})

describe("a mint recipe", () => {
	it("mints an API key with the jwt, sends it as ApiKey for the scope it needs, and revokes it", async () => {
		const { log, result } = await againstReference({
			ops: ["table.list"],
			principals: { alpha: PRINCIPALS.alpha as PrincipalEntry },
			security: SECURITY,
		})
		const minted = log.entries.filter((entry) => entry.path === "/v1/api-keys" && entry.status === 201)
		const asked = result.client.transcript.filter((e) => e.operationId === "apiKey.create" && e.status === 201)
		const keys = minted.map((entry, i) => ({
			...(JSON.parse(entry.answer) as { id: string; key: string }),
			scopes: (asked[i]?.requestBody as { scopes: string[] } | undefined)?.scopes ?? [],
		}))
		const reader = keys.find(({ scopes }) => scopes.join() === "table:read")
		expect(reader).toBeDefined()
		expect(status(result, "table.list")).toBe("passed")
		expect(sentTo(log, "/v1/projects/proj_alpha/tables")).toContain(`ApiKey ${reader?.key}`)
		expect(accepted(result, "table.list")).toContainEqual(["apiKey"])
		/* Each key the run minted is revoked by the end of the run. */
		const revoked = log.entries.filter((entry) => entry.method === "DELETE" && entry.path.startsWith("/v1/api-keys/"))
		expect(revoked.map((entry) => entry.path).sort()).toEqual(keys.map(({ id }) => `/v1/api-keys/${id}`).sort())
		const held = result.principals.find((principal) => principal.id === "alpha")?.credentials ?? []
		expect(held.filter((credential) => credential.scheme === "apiKey").map((c) => c.scopes)).toContainEqual([
			"table:read",
		])
	})
})

describe("a static recipe", () => {
	it("sends the fixed value in the scheme's place, signing nothing in", async () => {
		const token = await referenceToken((reference = await createMemoryServer()).url, "key_alpha")
		const url = reference.url
		const log = wireLog()
		const result = await run({
			baseUrl: url,
			network: { fetch: log.fetch },
			ops: ["profile.get"],
			principals: { alpha: {} },
			security: { jwt: { static: token } },
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		expect(status(result, "profile.get")).toBe("passed")
		expect(log.entries.some((entry) => entry.path.startsWith("/v1/auth/"))).toBe(false)
		expect(sentTo(log, "/v1/me")).toContain(`Bearer ${token}`)
		expect(accepted(result, "profile.get")).toContainEqual(["jwt"])
		expect(heldSchemes(result)).toEqual(["jwt"])
	})
})

describe("a hook recipe", () => {
	it("sends what resolveCredential returns for the scheme and principal", async () => {
		const token = await referenceToken((reference = await createMemoryServer()).url, "key_alpha")
		const url = reference.url
		const asked: Array<[string, CredentialPrincipal]> = []
		const log = wireLog()
		const result = await run({
			baseUrl: url,
			hooks: {
				resolveCredential: (scheme, principal) => {
					asked.push([scheme, principal])
					return Promise.resolve({ expiresIn: 3600, value: token })
				},
			},
			network: { fetch: log.fetch },
			ops: ["profile.get"],
			principals: { alpha: { email: "alpha@reference.test" } },
			security: { jwt: { hook: true } },
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		expect(status(result, "profile.get")).toBe("passed")
		expect(asked[0]).toEqual(["jwt", { id: "alpha", identity: { email: "alpha@reference.test" } }])
		expect(sentTo(log, "/v1/me")).toContain(`Bearer ${token}`)
		expect(accepted(result, "profile.get")).toContainEqual(["jwt"])
		expect(result.principals.find((principal) => principal.id === "alpha")?.credentials[0]).toMatchObject({
			expiresAt: expect.any(Number),
			scheme: "jwt",
		})
	})
})

/* An API whose one operation takes an OAuth 2 token, issued at /oauth/token for either grant. */
function oauthSpec(): OpenApiDocument {
	return {
		components: {
			securitySchemes: {
				oauth: {
					flows: {
						clientCredentials: { scopes: { "items:read": "read items" }, tokenUrl: "/oauth/token" },
						password: { scopes: { "items:read": "read items" }, tokenUrl: "/oauth/token" },
					},
					type: "oauth2",
				},
			},
		},
		info: { title: "oauth", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/items": {
				get: {
					operationId: "items.read",
					responses: {
						"200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" },
						"401": { description: "no token" },
						"403": { description: "wrong scope" },
					},
					security: [{ oauth: ["items:read"] }],
				},
			},
		},
	} as unknown as OpenApiDocument
}

/** What the token server was posted, and the bearer each item read carried. */
interface OAuthSeen {
	forms: Array<Record<string, string>>
	bearers: string[]
}

async function oauthServer(): Promise<{ seen: OAuthSeen; url: string }> {
	const seen: OAuthSeen = { bearers: [], forms: [] }
	const issued = new Set<string>()
	const server = await serve(listeners, oauthSpec(), [
		async ({ method, req, res, url }) => {
			if (method !== "POST" || url.pathname !== "/oauth/token") return false
			let raw = ""
			for await (const chunk of req) raw += String(chunk)
			seen.forms.push(Object.fromEntries(new URLSearchParams(raw)))
			const token = `at-${seen.forms.length}`
			issued.add(token)
			return reply(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer" })
		},
		({ req, res, url }) => {
			if (url.pathname !== "/v1/items") return false
			const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "")
			seen.bearers.push(bearer)
			return reply(res, issued.has(bearer) ? 200 : 401, issued.has(bearer) ? {} : { error: "unauthorized" })
		},
	])
	return { seen, url: server.url }
}

async function oauthRun(security: SecurityConfig, principals: PrincipalsConfig) {
	const { seen, url } = await oauthServer()
	const result = await run({ baseUrl: url, principals, security, seed: 1, spec: `${url}/v1/openapi/spec` })
	return { result, seen }
}

describe("an oauth2 recipe", () => {
	it("performs the client-credentials grant at the declared token URL and sends that token", async () => {
		const { result, seen } = await oauthRun(
			{ oauth: { oauth2: { clientId: "oat-client", clientSecret: "s3cret", flow: "clientCredentials" } } },
			{ alpha: {} },
		)
		expect(status(result, "items.read")).toBe("passed")
		expect(seen.forms[0]).toEqual({
			client_id: "oat-client",
			client_secret: "s3cret",
			grant_type: "client_credentials",
			scope: "items:read",
		})
		expect(seen.bearers).toContain("at-1")
		expect(accepted(result, "items.read")).toContainEqual(["oauth"])
		expect(result.principals[0]?.credentials).toEqual([
			{ expiresAt: expect.any(Number), scheme: "oauth", scopes: ["items:read"] },
		])
	})

	it("performs the password grant with the principal's own username and password", async () => {
		const { result, seen } = await oauthRun(
			{
				oauth: {
					oauth2: {
						clientId: "oat-client",
						flow: "password",
						password: "{principal.password}",
						username: "{principal.email}",
					},
				},
			},
			{ alpha: { email: "alpha@example.test", password: "alpha-pass" } },
		)
		expect(status(result, "items.read")).toBe("passed")
		expect(seen.forms[0]).toEqual({
			client_id: "oat-client",
			grant_type: "password",
			password: "alpha-pass",
			scope: "items:read",
			username: "alpha@example.test",
		})
		expect(seen.bearers).toContain("at-1")
		expect(accepted(result, "items.read")).toContainEqual(["oauth"])
	})
})
