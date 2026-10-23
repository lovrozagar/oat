/*
 * 0.25.0 credentials: one recipe per security scheme the document declares, and principals as
 * identity data. Where each credential goes comes from the scheme; a recipe says only how to get
 * the value.
 */

import type { AuthStep } from "./steps.ts"

/** Where a credential's lifetime comes from: seconds, or a JSON path into the answer that issued it. */
export type ExpiresIn = number | { from: string }

/** An extra place a credential is sent, beside the one its scheme declares. */
export interface ExtraPlacement {
	in: "header" | "query" | "cookie"
	name: string
	/** The value, with `{credential}` where the credential goes. Default: `{credential}`. */
	template?: string
}

/** Sign in by running steps; `from` is where the credential is in the last answer. */
export interface LoginRecipe {
	steps: [AuthStep, ...AuthStep[]]
	from: string
	/**
	 * What the answer binds into the principal: its `tenant`, or a `scope.<parameter>`. A value starting with
	 * `$` is a JSON path into the last answer's body, read as `from` is; any other is a JWT claim name,
	 * e.g. `{ tenant: "org_id", "scope.project_id": "$.project.id" }`.
	 */
	claims?: Record<string, string>
	/**
	 * The operation that revokes a session this recipe opened, sent with that session: a logout, or a
	 * token revoke with a `body` in which `{credential}` is the session's value, e.g.
	 * `{ operationId: "auth.revoke", body: { token: "{credential}" } }`. oat calls it for the dedicated
	 * sessions its security probes open, never for a principal's own.
	 */
	revoke?: string | { operationId: string; body?: unknown }
}

/** Make the credential by calling an operation with another scheme's credential. */
export interface MintRecipe {
	/** The scheme whose credential calls `operationId`. */
	with: string
	operationId: string
	/** The request body; `{scopes}` becomes the scope set an operation needs. */
	body?: unknown
	/** Where the minted credential is in the answer. */
	from: string
	/** The operation that revokes a minted credential, when the run is done with it. */
	revoke?: string
}

/** A value fixed in config: a token, or a basic pair. */
export type StaticRecipe = string | { username: string; password: string }

/** An OAuth 2 grant oat performs itself, at the token URL the document declares. */
export interface OAuth2Recipe {
	flow: "clientCredentials" | "password"
	clientId: string
	clientSecret?: string
	username?: string
	password?: string
	scopes?: string[]
}

interface RecipeOptions {
	/** Renew the credential before it lapses, by the same steps a login runs. */
	refresh?: { steps: [AuthStep, ...AuthStep[]]; from: string }
	/** The value written into the scheme's place, e.g. `ApiKey {credential}`. */
	format?: string
	expiresIn?: ExpiresIn
	/** The scopes a static or hooked credential carries, so scope-gated operations know it suffices. */
	holds?: string[]
	placements?: ExtraPlacement[]
}

/** How one scheme's credential is obtained: exactly one kind. */
export type Recipe = RecipeOptions &
	(
		| { login: LoginRecipe; mint?: never; static?: never; hook?: never; oauth2?: never }
		| { mint: MintRecipe; login?: never; static?: never; hook?: never; oauth2?: never }
		| { static: StaticRecipe; login?: never; mint?: never; hook?: never; oauth2?: never }
		/* `hooks.resolveCredential(scheme, principal)` returns it. */
		| { hook: true; login?: never; mint?: never; static?: never; oauth2?: never }
		| { oauth2: OAuth2Recipe; login?: never; mint?: never; static?: never; hook?: never }
	)

/** The recipe kinds, by the key that names each. */
export type RecipeKind = "login" | "mint" | "static" | "hook" | "oauth2"

/** A principal: identity data recipes interpolate as `{principal.<key>}`, plus how it is graded. */
export interface PrincipalEntry {
	[identity: string]: unknown
	/** The tenant it belongs to; principals in different tenants enable the isolation checks. */
	tenant?: string
	/** Path or query parameters bound for this principal, e.g. its `project_id`. Identity data never fills one. */
	scope?: Record<string, string>
	/** Higher can do everything a lower rank can. */
	rank?: number
	/** What an owner puts in an invite body for this principal. */
	inviteAs?: string
	/**
	 * The account may only read: a viewer. The security checks send its writes to a record the run
	 * created and expect each to be refused.
	 */
	readOnly?: true
	/** Made fresh for the run, by the operation the document marks `x-fresh-principal`. */
	fresh?: boolean
	/**
	 * Registered by its own login recipe, through an operation the document does not mark
	 * `x-fresh-principal`: the run made the account, so teardown removes it with `teardownPrincipal`.
	 */
	created?: boolean
	/** Per-scheme recipe overrides for this principal alone. */
	security?: Record<string, Partial<Recipe>>
}

/** The config's `security`: one recipe per scheme the document declares, by scheme name. */
export type SecurityConfig = Record<string, Recipe>
/** The config's `principals`: each principal's identity data, by id. */
export type PrincipalsConfig = Record<string, PrincipalEntry>
