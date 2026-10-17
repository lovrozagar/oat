/* Who oat acts as, and how each one signs in. */

import type { AuthStep } from "./steps.ts"

/** How to renew a credential without re-running the acquire chain. */
export interface AuthRefresh {
	/** Run against the existing scope so `{refreshToken}` interpolates. */
	steps: [AuthStep, ...AuthStep[]]
}

export interface AuthFlow {
	/** Run in order; values flow forward through the scope. First acquire only. */
	steps: [AuthStep, ...AuthStep[]]
	/** Where the credential is in the final response, e.g. `$.access_token`. */
	credentialFrom: string
	/** Lifetime in seconds, e.g. `$.expires_in`. Falls back to a JWT `exp`, then `assumeTtlMs`. */
	expiresInFrom?: string
	/** Header the credential is sent in. Defaults to `authorization`. */
	header?: string
	/** Defaults to `Bearer {credential}`. */
	template?: string
	/** Used only when neither the response nor the credential reveals an expiry. */
	assumeTtlMs?: number
	/**
	 * Proactive refresh fires when `expiresAt - now <= refreshBufferMs`.
	 * Defaults to 30_000. Ignored when `expiresAt` is null (static-header principal).
	 */
	refreshBufferMs?: number
	/**
	 * Renew via these steps (typically `auth.refreshToken` + `{refreshToken}`).
	 * Signup flows must set this — re-running `steps` would register again.
	 * Omitted: re-run `steps` (API-key / token-exchange). Register-like first hops fail closed.
	 */
	refresh?: AuthRefresh
}

/**
 * Credential harvested outside oat (Google OAuth on a harvest page, a KV pair).
 * oat polls `hooks.resolvePrincipalAuth` with the same backoff as `resolveOutOfBand`.
 */
export interface HookAuth {
	fromHook: string
	header?: string
	template?: string
	assumeTtlMs?: number
	refreshBufferMs?: number
}

export type PrincipalAuth = AuthFlow | HookAuth

export interface PrincipalAuthResult {
	credential: string
	refreshToken?: string
	expiresIn?: number
}

export interface Principal {
	id: string
	/** Sent on every request this principal makes — for a long-lived key, this is all you need. */
	headers?: Record<string, string>
	/** How to obtain a credential. Omit for a principal that authenticates by static header. */
	auth?: PrincipalAuth
	/** Path parameters this principal owns — its tenant. */
	roots?: Record<string, string>
	/**
	 * Path parameters the flow discovers rather than the config supplying them, mapping a
	 * parameter to the scope key the flow bound. A registration that provisions a tenant then
	 * needs no fixture identifiers configured at all.
	 */
	rootsFromFlow?: Record<string, string>
	/**
	 * Name of this principal's role (`owner`, `admin`, `member`, `viewer`, …). Free-form.
	 * Isolation still keys off `roots`, not this name: two `owner`s in different tenants are
	 * peers; an `owner` and a `viewer` sharing roots are a lattice.
	 */
	role?: string
	/**
	 * Position in the authorization lattice. Higher can do everything a lower rank can.
	 * Same rank + different `roots` is today's two-tenant isolation pair. Defaults to 0.
	 */
	rank?: number
	/**
	 * How the owner names this principal when inviting them — an API key, an email, whatever
	 * the invite operation's body field accepts. Required for `auth.invite-grants-then-revokes`.
	 */
	inviteAs?: string
}
