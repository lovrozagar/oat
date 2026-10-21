import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../../../config/types/security.ts"
import type { Answer, Responder } from "../../__fixtures__/harness.ts"
import type { OperationCheck } from "../../core/check.ts"
import { contextOf, optionsFor } from "../../../run/__fixtures__/api.ts"
import { runReadSecurity, runWriteSecurity } from "../../../run/security.ts"
import { securedDoc } from "./__fixtures__/secured-api.ts"
import { crossTenantKeyRefused } from "./auth-cross-tenant-key-refused.ts"
import { refreshReuseRefused } from "./auth-refresh-reuse-refused.ts"
import { revokedCredentialRefused } from "./auth-revoked-credential-refused.ts"

/*
 * Every credential these checks mint goes through the run's store, never a direct call to a mint
 * operation, so the store's teardown (`revokeAll`) revokes each one. The backend here issues and
 * revokes for real; after teardown no key and no session the checks made is still live.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ok = { "200": { description: "ok", ...json({ type: "object" }) } }

function doc() {
	return securedDoc({
		"/api-keys": {
			post: {
				operationId: "apiKey.create",
				requestBody: { required: true, ...json({ type: "object" }) },
				responses: ok,
			},
		},
	})
}

const SECURITY: SecurityConfig = {
	apiKey: {
		format: "ApiKey {credential}",
		mint: {
			body: { scopes: "{scopes}" },
			from: "$.key",
			operationId: "apiKey.create",
			revoke: "apiKey.revoke",
			with: "jwt",
		},
	},
	jwt: {
		login: {
			from: "$.access_token",
			revoke: { body: { token: "{credential}" }, operationId: "auth.revoke" },
			steps: [
				{
					body: { email: "{principal.email}", password: "password1" },
					operationId: "auth.login",
					saveAs: { refresh: "$.refresh_token" },
				},
			],
		},
		refresh: {
			from: "$.access_token",
			steps: [
				{ body: { refresh_token: "{refresh}" }, operationId: "auth.refresh", saveAs: { refresh: "$.refresh_token" } },
			],
		},
	},
}

const PRINCIPALS = {
	alpha: { email: "alpha@a.test", scope: { project_id: "proj_a" }, tenant: "proj_a" },
	beta: { email: "beta@b.test", scope: { project_id: "proj_b" }, tenant: "proj_b" },
}

/** What the backend issued and what is still live. */
interface Ledger {
	issued: number
	sessions: Map<string, { tenant: string; live: boolean }>
	refreshes: Map<string, { access: string; spent: boolean }>
	keys: Map<string, { id: string; tenant: string; live: boolean }>
}

function issue(ledger: Ledger, tenant: string): Answer {
	ledger.issued += 1
	const access = `jwt-${ledger.issued}`
	const refresh = `rt-${ledger.issued}`
	ledger.sessions.set(access, { live: true, tenant })
	ledger.refreshes.set(refresh, { access, spent: false })
	return { body: { access_token: access, refresh_token: refresh }, status: 200 }
}

/* A rotation: a spent refresh token, reused, kills its session. */
function rotate(ledger: Ledger, token: string): Answer {
	const used = ledger.refreshes.get(token)
	const session = used === undefined ? undefined : ledger.sessions.get(used.access)
	if (used === undefined || session === undefined) return { status: 401 }
	session.live = false
	if (used.spent) return { status: 401 }
	used.spent = true
	return issue(ledger, session.tenant)
}

/* The tenant of a live credential in the Authorization header, or undefined. */
function tenantOf(ledger: Ledger, auth: string | undefined): string | undefined {
	const [kind, value = ""] = (auth ?? "").split(" ")
	const held = kind === "Bearer" ? ledger.sessions.get(value) : kind === "ApiKey" ? ledger.keys.get(value) : undefined
	return held?.live === true ? held.tenant : undefined
}

interface Call {
	method: string
	path: string
	sent: Record<string, unknown>
	tenant: string
}

/* A request a live credential authenticated. */
function secured(ledger: Ledger, { method, path, sent, tenant }: Call): Answer | undefined {
	if (path === "/auth/revoke") {
		const session = ledger.sessions.get(String(sent.token))
		if (session !== undefined) session.live = false
		return { body: {}, status: 200 }
	}
	if (path === "/api-keys" && method === "POST") {
		ledger.issued += 1
		const id = `k${ledger.issued}`
		ledger.keys.set(`ak_${ledger.issued}`, { id, live: true, tenant })
		return { body: { key: `ak_${ledger.issued}`, key_id: id }, status: 200 }
	}
	if (method === "DELETE" && path.startsWith("/api-keys/")) {
		for (const key of ledger.keys.values()) if (`/api-keys/${key.id}` === path) key.live = false
		return { status: 204 }
	}
	const project = /^\/projects\/([^/]+)\//.exec(path)?.[1]
	if (project === undefined) return undefined
	return project === tenant ? { body: { items: [] }, status: 200 } : { status: 403 }
}

function backend(): { respond: Responder; ledger: Ledger } {
	const ledger: Ledger = { issued: 0, keys: new Map(), refreshes: new Map(), sessions: new Map() }
	const respond: Responder = (method, path, { body, headers }) => {
		const sent = (body ?? {}) as Record<string, unknown>
		if (path === "/openapi.json") return { body: doc(), status: 200 }
		if (path === "/auth/login") return issue(ledger, String(sent.email).endsWith("@a.test") ? "proj_a" : "proj_b")
		if (path === "/auth/refresh") return rotate(ledger, String(sent.refresh_token))
		const tenant = tenantOf(ledger, (headers as Record<string, string> | undefined)?.authorization)
		return tenant === undefined ? { status: 401 } : secured(ledger, { method, path, sent, tenant })
	}
	return { ledger, respond }
}

describe("credentials the security checks mint", () => {
	it("are all minted through the store, and all revoked at teardown", async () => {
		const { ledger, respond } = backend()
		const ctx = await contextOf(optionsFor(respond, { principals: PRINCIPALS, security: SECURITY }))
		/* The principals' own sessions, signed in first: the run's, not the checks'. */
		const own = await Promise.all(
			["alpha", "beta"].map(async (principal) => {
				const held = await ctx.store.acquire({ principal, scheme: "jwt" })
				if ("blocked" in held) throw new Error(held.blocked)
				return held.value
			}),
		)
		await runReadSecurity(ctx, [crossTenantKeyRefused as OperationCheck])
		await runWriteSecurity(ctx, [revokedCredentialRefused, refreshReuseRefused] as OperationCheck[])
		expect(ctx.findings.findings).toEqual([])
		expect(
			ctx.state.checksSkipped.filter((skip) => /untested|recipe/.test(skip.needs) && !/runs on/.test(skip.needs)),
		).toEqual([])
		const minted = [...ledger.keys.keys()]
		/* alpha's dedicated key for the revoke probe, and beta's key for the cross-tenant probe, at least. */
		expect(minted.length).toBeGreaterThanOrEqual(2)
		expect(ledger.sessions.size).toBeGreaterThanOrEqual(4)
		expect(await ctx.store.revokeAll()).toEqual([])
		expect([...ledger.keys.values()].filter((key) => key.live)).toEqual([])
		const live = [...ledger.sessions.entries()].filter(([, session]) => session.live).map(([access]) => access)
		expect(live.toSorted()).toEqual(own.toSorted())
	})
})
