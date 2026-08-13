/**
 * The public configuration surface — and the single source of truth for its types.
 *
 * The runtime imports these definitions rather than declaring its own, so a mistake in a config
 * is a compile error rather than a surprise at request time. Everything backend-specific lives
 * here or in `x-*` spec tags; oat itself knows nothing about any particular API.
 */

/* ------------------------------------------------------------------ auth steps */

interface StepBase {
	/**
	 * Binds parts of the response into the flow's scope. Later steps interpolate them as
	 * `{name}`, and `rootsFromFlow` can promote them to path parameters. Values are addressed by
	 * path: `$.access_token`, `$.orgs.0.id`.
	 */
	saveAs?: Record<string, string>
	/**
	 * Binds values out of a JWT's claims. Tenancy commonly rides in the token rather than the
	 * response body, and a principal that can name its own tenant needs no roots configured. The
	 * signature is not verified — oat is reading its own credential, not trusting a third party.
	 */
	saveClaimsFrom?: { token: string; bind: Record<string, string> }
	/** Literal values bound before the step runs, with `{name}` interpolation. */
	bind?: Record<string, string>
	/** Accepted statuses. Defaults to any 2xx. */
	expect?: number[]
}

/** Calls an operation named in the document. Prefer this — it survives the path moving. */
export interface OperationStep extends StepBase {
	operationId: string
	body?: unknown
	headers?: Record<string, string>
	query?: Record<string, string>
}

/** Calls a raw path, for endpoints the document does not describe. */
export interface RequestStep extends StepBase {
	method: string
	path: string
	body?: unknown
	headers?: Record<string, string>
	query?: Record<string, string>
}

/**
 * A value that never travels over HTTP — an emailed verification token, an OTP, a magic link.
 *
 * oat declares the need and calls `hooks.resolveOutOfBand` to satisfy it, polling with backoff
 * because such stores are usually eventually consistent. That hook is the entire coupling
 * surface between oat and one specific backend.
 */
export interface OutOfBandStep {
	outOfBand: { address: string; kind: string; as: string }
}

export type AuthStep = OperationStep | RequestStep | OutOfBandStep

/* ----------------------------------------------------------------- auth flows */

export interface AuthFlow {
	/** Run in order; values flow forward through the scope. */
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
}

export interface Principal {
	id: string
	/** Sent on every request this principal makes — for a long-lived key, this is all you need. */
	headers?: Record<string, string>
	/** How to obtain a credential. Omit for a principal that authenticates by static header. */
	auth?: AuthFlow
	/** Path parameters this principal owns — its tenant. */
	roots?: Record<string, string>
	/**
	 * Path parameters the flow discovers rather than the config supplying them, mapping a
	 * parameter to the scope key the flow bound. A registration that provisions a tenant then
	 * needs no fixture identifiers configured at all.
	 */
	rootsFromFlow?: Record<string, string>
}

/* ---------------------------------------------------------------------- hooks */

export interface OutOfBandRequest {
	address: string
	kind: string
	/** 1-based; oat retries with backoff until a value arrives or the attempts run out. */
	attempt: number
}

export interface Hooks {
	/** Return `null` to ask oat to retry — the value may simply not have arrived yet. */
	resolveOutOfBand?: (request: OutOfBandRequest) => Promise<string | null>
	/**
	 * Removes a principal the run provisioned, and everything that principal created with it.
	 * Usually the only handle that works: per-record deletes are typically owner-scoped, and the
	 * credential dies with the run.
	 */
	teardownPrincipal?: (address: string) => Promise<void>
}

/* --------------------------------------------------------------------- config */

export interface OatConfig {
	/** OpenAPI document — an http(s) URL or a filesystem path. JSON or YAML. */
	spec: string
	/** Backend under test. */
	baseUrl: string
	/**
	 * At least one principal. A second in a different tenant is what makes the isolation checks
	 * possible — without it they are skipped rather than silently passed.
	 */
	principals: [Principal, ...Principal[]]
	hooks?: Hooks
	/** Sent on every request. Opaque to oat — bypass headers, API versioning, tracing. */
	globalHeaders?: Record<string, string>
	/** Path parameters oat cannot create. Also declarable in-spec via `x-root`. */
	roots?: Record<string, string>
	/** Fixture generation derives from this, so a failing run is exactly reproducible. */
	seed?: number
	/** Instances seeded per entity. Larger cohorts discriminate more, and cost more. */
	cohortSize?: number
	/** Entities tested in parallel. Checks within one entity always stay ordered. */
	concurrency?: number
	/** Requests allowed in flight at once. Past a server's comfort this makes runs slower. */
	maxInFlight?: number
	/** Restrict the run to these entity names. */
	only?: string[]
	/** Leave created records in place instead of tearing them down. */
	keepFixtures?: boolean
	/** Report destination. Defaults to `./oat-out`. */
	outDir?: string
}

/**
 * Identity function that gives a config file full type checking and editor completion.
 *
 * ```ts
 * import { defineConfig } from "oat"
 *
 * export default defineConfig({
 *   spec: "https://api.example.com/openapi.json",
 *   baseUrl: "https://api.example.com",
 *   principals: [{ id: "alpha", headers: { authorization: `Bearer ${process.env.TOKEN}` } }],
 * })
 * ```
 */
export function defineConfig(config: OatConfig): OatConfig {
	return config
}
