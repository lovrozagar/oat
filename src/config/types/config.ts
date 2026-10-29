/* The config file's top level: the target, the principals, and every knob a run reads. */

import type { Hooks, OutOfBandConfig, Uploads } from "./hooks.ts"
import type { DeclaredFilterGrammar, DeclaredSortGrammar, QueryCapabilities } from "./query.ts"
import type { PrincipalsConfig, SecurityConfig } from "./security.ts"
import type { Scenario } from "./steps.ts"

/** Per-entity overlays. Only `query` is in scope this release. Unknown names are ignored. */
export interface EntityConfig {
	query?: QueryConfig
}

/** Query capabilities, plus the grammar filter terms are written in when oat cannot infer it. */
export type QueryConfig = QueryCapabilities & {
	/** A preset name or a template; outranks `x-query.grammar`. See docs/configuration/reference.md. */
	grammar?: DeclaredFilterGrammar
	/** A preset name or a template; outranks `x-query.sortGrammar`. */
	sortGrammar?: DeclaredSortGrammar
}

/** A second host with its own OpenAPI. Its schemes send the primary's credentials only where `security` maps them. */
export interface OriginSpec {
	id: string
	baseUrl: string
	/** This origin's document, read as the primary `spec` is: a relative path from this config's folder. */
	spec: string
	/** Requests per second this origin takes from oat in all, as `maxRps` is for `baseUrl`. */
	maxRps?: number
	/** Patches to this origin's document, as `overlay` is for the primary. */
	overlay?: SpecOverlay
	/** Which primary recipe each of this origin's schemes sends, e.g. `{ bearer: "jwt" }`. An unmapped scheme sends nothing. */
	security?: Record<string, string>
}

/* -------------------------------------------------------------------- profiles */

/**
 * Which operations a run is allowed to touch, filtering on what `x-cost` / `x-destructive`
 * already declare (parsed onto every `OperationModel`, unconsulted until a profile selects one).
 *
 * Two profiles always exist without being declared here: `"full"` (no gating — today's default
 * behavior) and `"cheap"` (`{ maxCost: "low" }`). Anything more specific than a cost band —
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

/** How much of the string payload catalog a run sends. */
export type PayloadPolicy = "full" | "per-write-path"

/** Checks that run only when switched on, by check id. Every other check runs wherever it applies. */
export interface CheckSwitches {
	/**
	 * Sends failed logins, for an identity that does not exist, until the login answers 429 or a cap
	 * is reached. Off by default: a throttle that counts by address or client can still slow every
	 * login from the machine running oat for a while.
	 */
	"auth.login-throttled"?: boolean
}

export interface OatConfig {
	/** Declared flows for operations the matrix cannot reach. See `Scenario`. */
	scenarios?: Scenario[]
	/** OpenAPI document — an http(s) URL, a filesystem path relative to this config, or a route below `baseUrl`. JSON or YAML. */
	spec: string
	/** Backend under test. */
	baseUrl: string
	/**
	 * At least one principal, by id. Isolation needs a second with a different `tenant`. A lattice
	 * needs several that share a tenant and differ in `rank`. Extra principals are not ignored.
	 */
	principals: PrincipalsConfig
	/** The principal that writes: makes the records every check works on. Unset, the first principal. */
	writer?: string
	/** How each scheme the document declares gets its credential: one recipe per scheme. */
	security?: SecurityConfig
	hooks?: Hooks
	/** File pool for multipart / binary parts. `resolveUpload` lives on `hooks`. */
	uploads?: Uploads
	/**
	 * Sent on every request; never a credential, which its scheme places. Request-id / correlation-id
	 * headers are recorded on each exchange; the rest is opaque.
	 */
	globalHeaders?: Record<string, string>
	/**
	 * The cache bypass oat sends on every documented read: the read's `x-consistency` bypass, else
	 * `Cache-Control: no-cache`. `bypass: false` sends none, for an API whose firewall refuses the
	 * header or whose caches are to be tested as they are. A header `globalHeaders` sets wins.
	 */
	cache?: { bypass?: boolean }
	/** Header names whose values are secret though they carry no credential, scrubbed wherever a run records them. */
	redact?: { headers?: string[] }
	/**
	 * Extra hosts, each with its own document. Do not merge those routes into the primary spec.
	 * After primary auth, oat binds the same principals and runs the matrix against each origin.
	 * A second `defineConfig` can also reuse `.oat/runs/latest/principals.json` via `loadPersistedPrincipals`.
	 */
	origins?: OriginSpec[]
	/**
	 * Patches to a document you cannot change, applied before oat reads it: operations by
	 * `operationId`, component schemas by name. Objects merge, arrays replace, `null` deletes. A
	 * patch naming nothing in the document stops the run with a usage error.
	 */
	overlay?: SpecOverlay
	/**
	 * The only operationIds oat may call. Every other operation leaves the document after the
	 * overlay and before oat reads it, so neither the matrix, the contract floor, scenarios nor
	 * teardown can reach it. An entry naming nothing, or an auth or scenario step needing a removed
	 * operation, stops the run with a usage error.
	 */
	allow?: string[]
	/** `failRun: false` keeps a run whose requests `hooks.beforeRequest` refused from failing on that alone. */
	fence?: { failRun?: boolean }
	/**
	 * `verify: false` skips reading each list again after teardown. By default a record still
	 * listed after its delete answered 2xx is reported as a leftover.
	 */
	teardown?: { verify?: boolean }
	/**
	 * A file of known findings, as `oat baseline --from <run>` writes it, relative to this config.
	 * A finding it names is reported as known and does not fail the run; an entry nothing matches
	 * is reported as fixed.
	 */
	baseline?: string
	/**
	 * Where the backend says which build it is, read once after sign-in: an `operationId` or a
	 * `path`, and `from` — `$.json.path` into the body or `header:<name>`. Reports and `oat diff`
	 * show it; a version that cannot be read is noted and never fails the run.
	 */
	targetVersion?: TargetVersionSpec
	/**
	 * Backoff for `resolveOutOfBand`.
	 * Defaults: `{ attempts: 6, initialMs: 200, maxMs: 3000 }` (~9s worst case).
	 */
	outOfBand?: OutOfBandConfig
	/**
	 * How much of the 159-case string payload catalog to send. `"per-write-path"` (the default)
	 * sends all of it once per distinct write path — request media type and field type — and a
	 * representative family of each kind elsewhere; `"full"` sends all of it to every field.
	 */
	payloads?: PayloadPolicy
	/** Checks switched on that do not run by default: `{ "auth.login-throttled": true }`. */
	checks?: CheckSwitches
	/** Fixture generation derives from this, so a failing run is exactly reproducible. */
	seed?: number
	/** Instances seeded per entity. Larger cohorts discriminate more, and cost more. */
	cohortSize?: number
	/** Requests allowed in flight at once. Past a server's comfort this makes runs slower. */
	maxInFlight?: number
	/**
	 * Requests per second oat sends to `baseUrl` in all, across every route. For a limit no route
	 * declares, such as a CDN or firewall that caps each client IP: tripping it blocks the whole
	 * run. Routes still keep their own `rateLimits` and `x-rate-limit` budgets under it.
	 */
	maxRps?: number
	/** Grade every operation these entities own, and nothing else. Joins `ops` as a union. */
	only?: string[]
	/**
	 * Grade only these operationIds; every other operation is support — called to reach or observe
	 * a target, never graded. `*` globs within an id (`row.*`); `<originId>:<operationId>` targets a
	 * secondary origin. `--ops` on the CLI replaces this list.
	 */
	ops?: string[]
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
	query?: QueryConfig
	/** Per-entity overlays. Unknown names are ignored (`oat doctor` warns). */
	entities?: Record<string, EntityConfig>
	/** Leave created records in place instead of tearing them down. */
	keepFixtures?: boolean
	/**
	 * History root, relative to this config. Each run writes `<outDir>/<datetime>/` and updates
	 * `<outDir>/latest`. Defaults to `./.oat/runs` in the working directory.
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
		/**
		 * `AbortSignal` timeout per attempt, in ms. Live `run` defaults to 180_000.
		 * `0` disables it (the request waits for the socket — not recommended for streams).
		 */
		requestTimeoutMs?: number
	}
}

/** Where a run reads the target's version from, to stamp the report with it. */
export interface TargetVersionSpec {
	/** The operation to read it from. Its path parameters come from the first principal's scope. */
	operationId?: string
	/**
	 * A path below the base URL, when no operation in the document serves it. It is read anonymously,
	 * unless `scheme` names the credential the first principal sends.
	 */
	path?: string
	/** The declared scheme a `path` read sends as the first principal. Without it the read is anonymous. */
	scheme?: string
	/** `$.json.path` into the body, or `header:<name>`. */
	from: string
}

/**
 * Patches to a document the tester cannot change, applied from config before anything reads it.
 */
export interface SpecOverlay {
	/** Patches by `operationId`. A patch's own `operationId` renames the operation. */
	operations?: Record<string, Record<string, unknown>>
	/** Patches by component schema name. */
	schemas?: Record<string, Record<string, unknown>>
	/**
	 * Security schemes merged into `components.securitySchemes`: a new name declares a scheme the
	 * document lacks, a known one is patched, and `null` deletes it.
	 */
	securitySchemes?: Record<string, Record<string, unknown> | null>
	/** The document's root `security`, replaced: `[{ bearer: [] }]` requires that scheme everywhere it is not overridden. */
	security?: Array<Record<string, string[]>>
}
