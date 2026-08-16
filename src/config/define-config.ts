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

/* -------------------------------------------------------------------- profiles */

/**
 * Which operations a run is allowed to touch, filtering on what `x-cost` / `x-destructive`
 * already declare (parsed onto every `OperationModel`, unconsulted until a profile selects one).
 *
 * Two profiles always exist without being declared here: `"full"` (no gating — today's default
 * behaviour) and `"cheap"` (`{ maxCost: "low" }`). Anything more specific than a cost band —
 * "skip the extraction endpoints that call a paid inference API" — is a named entry here.
 */
export interface ProfileSpec {
	/** Inclusive ceiling. An operation costing more than this is excluded. */
	maxCost?: "low" | "medium" | "high"
	/** Excludes every operation declaring `x-destructive: true`. */
	excludeDestructive?: boolean
	/** Exact `operationId`s to exclude regardless of cost or destructiveness — the escape hatch. */
	exclude?: string[]
}

/* ----------------------------------------------------------------- rate limits */

/**
 * A path/operation matcher paired with a rate, independent of any `x-rate-limit` tag — this is
 * what keeps oat able to pace itself against a backend that has not adopted the tag yet, or
 * against an environment (staging, usually) whose real limit differs from what the document
 * claims for production.
 */
export interface RateLimitSpec {
	/**
	 * One of: an exact `operationId`; a path pattern such as `/v1/auth/*` (optionally prefixed
	 * with a method, `POST /v1/auth/login`), `*` matching one path segment; or `category:<name>`
	 * to target every operation whose `x-rate-limit` tag declares that category, without
	 * enumerating its routes.
	 */
	match: string
	rps: number
	/**
	 * Bucket name to share with a tag-declared category — lets one rule override the rate for an
	 * entire category. Defaults to `match`, so a route-scoped rule still works standalone.
	 */
	category?: string
}

/* --------------------------------------------------------------------- config */

export interface OatConfig {
	/** OpenAPI document — an http(s) URL or a filesystem path. JSON or YAML. */
	spec: string
	/** Backend under test. */
	baseUrl: string
	/**
	 * At least one principal. Isolation needs a second with different `roots`. A lattice
	 * needs several that share `roots` and differ in `rank`. Extra principals are not ignored.
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
	/**
	 * Named profiles this run can select between, keyed by name. `"full"` and `"cheap"` exist
	 * implicitly and need no entry here; add one only for a profile a cost band can't express.
	 */
	profiles?: Record<string, ProfileSpec>
	/** Active profile by name. `--profile` on the CLI overrides this. Defaults to `"full"`. */
	profile?: string
	/**
	 * Paces requests per category so oat's own traffic never trips a documented rate limit and
	 * reports the trip as a backend defect. Checked before `x-rate-limit` tags for the same
	 * request — the environment-specific belief wins over the document's general claim.
	 */
	rateLimits?: RateLimitSpec[]
	/** Leave created records in place instead of tearing them down. */
	keepFixtures?: boolean
	/** Report destination. Defaults to `./oat-out`. */
	outDir?: string
}

/**
 * Identity function that gives a config file full type checking and editor completion.
 *
 * ```ts
 * import { defineConfig } from "@lovrozagar/oat"
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
