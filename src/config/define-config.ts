/**
 * The public configuration surface — and the single source of truth for its types.
 *
 * The runtime imports these definitions rather than declaring its own, so a mistake in a config
 * is a compile error rather than a surprise at request time. Everything backend-specific lives
 * here or in `x-*` spec tags; oat itself knows nothing about any particular API.
 */

import type { FilterableField, QueryCapabilities } from "../spec/query-capabilities.ts"

export type {
	FieldType,
	FilterOp,
	FilterableField,
	FilterableFrom,
	QueryCapabilities,
	SortableField,
} from "../spec/query-capabilities.ts"

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
	/** Named `origins[]` entry. Omit to hit the primary `baseUrl`. */
	origin?: string
}

/** Calls a raw path, for endpoints the document does not describe. */
export interface RequestStep extends StepBase {
	method: string
	path: string
	body?: unknown
	headers?: Record<string, string>
	query?: Record<string, string>
	/** Named `origins[]` entry. Omit to hit the primary `baseUrl`. */
	origin?: string
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

export function isHookAuth(auth: PrincipalAuth): auth is HookAuth {
	return "fromHook" in auth && typeof auth.fromHook === "string" && !("steps" in auth)
}

export function isAuthFlow(auth: PrincipalAuth): auth is AuthFlow {
	return "steps" in auth
}

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

/* ---------------------------------------------------------------------- hooks */

export interface OutOfBandRequest {
	address: string
	kind: string
	/** 1-based; oat retries with backoff until a value arrives or the attempts run out. */
	attempt: number
}

/**
 * Poll schedule for `resolveOutOfBand` and `resolvePrincipalAuth`.
 *
 * Defaults match 0.6.2: 6 attempts, 200 ms first sleep, doubling, cap 3000 ms.
 * Worst-case wait is the sum of every sleep, including after the last miss:
 * `200+400+800+1600+3000+3000 = 9000` ms. `{ attempts: 20, initialMs: 1000, maxMs: 8000 }`
 * is `1000+2000+4000+8000×17 = 143000` ms. The hook must not sleep; oat owns the backoff.
 */
export interface OutOfBandConfig {
	attempts?: number
	initialMs?: number
	maxMs?: number
}

export interface HeaderRequest {
	method: string
	url: string
	operationId?: string
}

export interface InputRequest {
	operationId: string
	/** Property name at this depth. */
	field: string
	/** JSON-path style pointer, e.g. `$.payment_method_id`. */
	pointer: string
	schema: unknown
}

export interface SideEffectRequest {
	/** The write that should have produced the side effect. */
	operationId: string
	/** Latest poll body, or the write response when no poll has landed yet. */
	record: unknown
	attempt: number
}

export interface UploadRequest {
	operationId: string
	/** The request's multipart / json / urlencoded media type. */
	mediaType: string
	/** Form part name. */
	field: string
	/** Part's declared type, e.g. `application/pdf`. */
	contentMediaType?: string
	filename?: string
	/** Cohort variant. */
	variant: string
	index: number
	/** Set when `uploads.each` is driving this invocation. */
	fixture?: {
		path: string
		filename: string
		index: number
		total: number
	}
}

export interface UploadFile {
	bytes: Uint8Array
	filename: string
	mediaType: string
}

/**
 * Exact body or part. `null` falls through to each / pool / dummy.
 * `UploadFile` replaces that field.
 * `{ fields }` that includes a file part replaces the whole request.
 * `{ fields }` that omits the file part overlays scalars and keeps each / pool / dummy bytes.
 */
export type UploadResolution = UploadFile | { fields: Record<string, string | UploadFile> } | null

export interface Uploads {
	/**
	 * Files oat may pick from. Globs and directories, relative to the config file.
	 * Matched by extension / sniffed type against the part's contentMediaType.
	 * Same seed → same pick. Empty match → dummy (do not fail the run).
	 */
	pool?: string[]
	/**
	 * operationId → globs / paths, relative to the config file.
	 * Present → that operation is invoked once per matched file (after eachMax).
	 * Absent → pick-one (resolveUpload → pool → dummy).
	 */
	each?: Record<string, string[]>
	/** Per-operation cap on `each` matches. Default: no cap. */
	eachMax?: number
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
	/**
	 * Exact file or whole request. Return `null` to fall through to `uploads.each`, then pool, then a dummy.
	 * `UploadFile` replaces that field. `{ fields }` with a file replaces the whole request.
	 * `{ fields }` without the file part overlays scalars and keeps the each / pool / dummy bytes.
	 * A hook that ignores `request.fixture` and always returns the same file will send that file N times.
	 */
	resolveUpload?: (request: UploadRequest) => Promise<UploadResolution>
	/**
	 * Per-request headers, merged after `globalHeaders` and before the principal's credential.
	 * Called on every dispatch (including 401 retries) so a one-shot captcha token can be fresh.
	 * Return `null` or `{}` to add nothing. oat does not speak Turnstile.
	 */
	resolveHeaders?: (request: HeaderRequest) => Promise<Record<string, string> | null>
	/**
	 * Replace a generated JSON field. Return `null` to keep the generator.
	 * Same idea as `resolveUpload`, for JSON (Stripe `pm_…`, vendor tokens).
	 */
	resolveInput?: (request: InputRequest) => Promise<unknown | null>
	/**
	 * Harvested principal: `auth: { fromHook: "oauth-google" }`.
	 * Return `null` to retry with the `outOfBand` backoff so a human can finish the click.
	 */
	resolvePrincipalAuth?: (fromHook: string) => Promise<PrincipalAuthResult | null>
	/**
	 * After a write that declares `x-wait`, return `true` when the side effect is visible.
	 * `null` retries until `x-wait.timeoutMs` (default 30s).
	 */
	awaitSideEffect?: (request: SideEffectRequest) => Promise<true | null>
	/**
	 * After seed, add or replace any axis of the query catalog for one entity. Return `null`
	 * to keep the merged tag+config catalog. A provided `filterable` / `sortable` /
	 * `searchable` / `selectable` list replaces that axis; omitted axes stay. `get` runs a
	 * named operation (or `"GET /path"`) with the seeded scope so a follow-up read can
	 * harvest dynamic columns.
	 */
	resolveQueryCapabilities?: (
		request: QueryCapabilitiesRequest,
	) => Promise<FilterableField[] | Partial<QueryCapabilities> | null>
}

export interface QueryCapabilitiesRequest {
	entity: string
	scope: Record<string, string>
	get: (operationId: string, scope?: Record<string, string>) => Promise<unknown>
}

/** Per-entity overlays. Only `query` is in scope this release. Unknown names are ignored. */
export interface EntityConfig {
	query?: QueryCapabilities
}

/** A second host with its own OpenAPI. Auth stays on the primary; the JWT is reused. */
export interface OriginSpec {
	id: string
	baseUrl: string
	spec: string
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
	/** File pool for multipart / binary parts. `resolveUpload` lives on `hooks`. */
	uploads?: Uploads
	/** Sent on every request. Request-id / correlation-id headers are recorded on each exchange; the rest is opaque. */
	globalHeaders?: Record<string, string>
	/**
	 * Extra hosts, each with its own document. Do not merge those routes into the primary spec.
	 * After primary auth, oat binds the same principals and runs the matrix against each origin.
	 * A second `defineConfig` can also reuse `.oat/runs/latest/principals.json` via `loadPersistedPrincipals`.
	 */
	origins?: OriginSpec[]
	/**
	 * Backoff for `resolveOutOfBand` and `resolvePrincipalAuth`.
	 * Defaults: `{ attempts: 6, initialMs: 200, maxMs: 3000 }` (~9s worst case).
	 */
	outOfBand?: OutOfBandConfig
	/** Path parameters oat cannot create. Also declarable in-spec via `x-root`. */
	roots?: Record<string, string>
	/** Fixture generation derives from this, so a failing run is exactly reproducible. */
	seed?: number
	/** Instances seeded per entity. Larger cohorts discriminate more, and cost more. */
	cohortSize?: number
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
	/**
	 * Global filter catalog defaults. Overlay on every entity after the list operation's `x-query`.
	 * Does not invent operators — new ops still have to be listed here or on the tag.
	 */
	query?: QueryCapabilities
	/** Per-entity overlays. Unknown names are ignored (`oat doctor` warns). */
	entities?: Record<string, EntityConfig>
	/** Leave created records in place instead of tearing them down. */
	keepFixtures?: boolean
	/**
	 * History root. Each run writes `<outDir>/<datetime>/` and updates `<outDir>/latest`.
	 * Defaults to `./.oat/runs`.
	 */
	outDir?: string
	/**
	 * Persist every HTTP exchange under the run dir (`exchanges.jsonl`, `exchanges/`, `blobs/`).
	 * Default on unless the active profile is `cheap`. CLI `--save-exchanges` /
	 * `--no-save-exchanges` override this. `--quiet` does not.
	 */
	saveExchanges?: boolean
	/**
	 * What to do when `fetch` throws (offline, DNS, reset, timeout) instead of returning HTTP.
	 * Not a 5xx policy. Default: 4 retries (~8s), then wait up to 60s for the link, then stop.
	 */
	network?: {
		retries?: number
		/** Pause-and-probe budget after per-request retries, in ms. `0` skips the wait. */
		waitMs?: number
		/** Optional `AbortSignal` timeout per attempt. Unset = wait for the socket (today's behaviour). */
		requestTimeoutMs?: number
	}
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
