/*
 * Compile-time test, checked by `tsc -p tsconfig.test.json` (part of `bun check`).
 *
 * The config a user writes: a recipe is exactly one kind, a principal's known keys are typed while
 * its identity data stays open, and `defineConfig` checks a literal against `OatConfig` in place.
 * Each `@ts-expect-error` line must fail to compile; if one stops failing, the check fails.
 */
import { expectTypeOf } from "vitest"
import { defineConfig, env } from "../../src/index.ts"
import type { OatConfig, PrincipalEntry, Recipe } from "../../src/index.ts"

/* Each recipe kind alone, with the options every kind takes. */
const recipes: Recipe[] = [
	{ static: "token" },
	{ static: { password: "p", username: "u" }, holds: ["read"] },
	{ hook: true, expiresIn: 3600 },
	{ login: { from: "$.access_token", steps: [{ operationId: "auth.login" }] }, expiresIn: { from: "$.expires_in" } },
	{ mint: { from: "$.key", operationId: "keys.create", with: "jwt" }, format: "ApiKey {credential}" },
	{ oauth2: { clientId: "id", clientSecret: "s", flow: "clientCredentials" } },
	{ static: "t", placements: [{ in: "query", name: "api_key" }] },
]
expectTypeOf(recipes).toEqualTypeOf<Recipe[]>()

// @ts-expect-error a recipe names exactly one kind, never two
const twoKinds: Recipe = { mint: { from: "$.k", operationId: "keys.create", with: "jwt" }, static: "t" }

// @ts-expect-error a recipe names a kind
const noKind: Recipe = { expiresIn: 60 }

// @ts-expect-error a hooked recipe is `hook: true`, not a flag that could be false
const hookOff: Recipe = { hook: false }

// @ts-expect-error a login runs at least one step
const noSteps: Recipe = { login: { from: "$.t", steps: [] } }

// @ts-expect-error oat performs only the clientCredentials and password grants
const deviceGrant: Recipe = { oauth2: { clientId: "id", flow: "deviceCode" } }

/* A principal: open identity data, typed grading keys. */
const principal: PrincipalEntry = {
	email: "a@example.test",
	rank: 2,
	readOnly: true,
	scope: { project_id: "p1" },
	security: { jwt: { expiresIn: 60 } },
	tenant: "t1",
}
expectTypeOf(principal["email"]).toBeUnknown()
expectTypeOf(principal.tenant).toEqualTypeOf<string | undefined>()

// @ts-expect-error a tenant is a string
const numericTenant: PrincipalEntry = { tenant: 1 }

// @ts-expect-error a rank is a number
const textRank: PrincipalEntry = { rank: "admin" }

// @ts-expect-error a scope binds parameters to strings
const numericScope: PrincipalEntry = { scope: { project_id: 1 } }

// @ts-expect-error readOnly is set or absent, never false
const writable: PrincipalEntry = { readOnly: false }

/* defineConfig returns the config as OatConfig, typing a literal and its callbacks in place. */
const config = defineConfig({
	baseUrl: env("OAT_BASE_URL"),
	hooks: {
		resolveCredential: async (scheme, caller) => {
			expectTypeOf(scheme).toBeString()
			expectTypeOf(caller.identity).toEqualTypeOf<Readonly<Record<string, unknown>>>()
			return { expiresIn: 60, value: `${scheme}:${caller.id}` }
		},
	},
	principals: { alpha: { tenant: "t1" } },
	security: { bearer: { hook: true } },
	spec: "openapi.json",
})
expectTypeOf(config).toEqualTypeOf<OatConfig>()
expectTypeOf(env).returns.toBeString()

defineConfig({
	baseUrl: "http://api.test",
	principals: {},
	// @ts-expect-error a misspelled top-level field is refused, not ignored
	specs: "openapi.json",
})

defineConfig({
	baseUrl: "http://api.test",
	principals: {},
	// @ts-expect-error a recipe inside the config is checked as a Recipe
	security: { bearer: { mint: { from: "$.k", operationId: "keys.create", with: "jwt" }, static: "t" } },
	spec: "openapi.json",
})

defineConfig({
	baseUrl: "http://api.test",
	hooks: {
		// @ts-expect-error a credential hook answers a string, an answer with its lifetime, or null
		resolveCredential: async () => 42,
	},
	principals: {},
	spec: "openapi.json",
})

export type Unused = [typeof twoKinds, typeof noKind, typeof hookOff, typeof noSteps, typeof deviceGrant]
export type UnusedPrincipals = [typeof numericTenant, typeof textRank, typeof numericScope, typeof writable]
