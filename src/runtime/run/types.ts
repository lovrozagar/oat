import type { BaselineEntry, BaselineFile } from "../baseline.ts"
import type { Client } from "../../client/client.ts"
import type {
	CheckSwitches,
	EntityConfig,
	OriginSpec,
	PayloadPolicy,
	ProfileSpec,
	QueryConfig,
	RateLimitSpec,
} from "../../config/types/config.ts"
import type { Hooks, OutOfBandConfig, Uploads } from "../../config/types/hooks.ts"
import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import type { CredentialStore } from "../../credentials/store.ts"
import type { Scenario } from "../../config/types/steps.ts"
import type { FencedRequest } from "../fence.ts"
import type { Finding, Inconclusive } from "../finding.ts"
import type { NetworkKind } from "../../errors/network.ts"
import type { SpoolOptions } from "../transcript/spool.ts"
import type { KeptCredential, PersistedPrincipal } from "../principals.ts"
import type { ProgressHandler } from "../progress/types.ts"
import type { ScopeReport } from "../scope/types.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { SpecOverlay } from "../../spec/overlay.ts"
import type { TargetVersion, TargetVersionSpec } from "../target-version.ts"
import type { TeardownReport } from "../teardown/types.ts"

export interface RunOptions {
	spec: string
	baseUrl: string
	/** The config's principals, by id. */
	principals: PrincipalsConfig
	/** One recipe per scheme the document declares; see `OatConfig.security`. */
	security?: SecurityConfig
	/** Extra secret header names; see `OatConfig.redact`. */
	redact?: { headers?: string[] }
	hooks?: Hooks
	uploads?: Uploads
	/** Directory of the config file — pool globs are resolved from here. */
	configDir?: string
	seed?: number
	cohortSize?: number
	globalHeaders?: Record<string, string>
	/** Entity names; each expands into the target set. */
	only?: string[]
	/**
	 * Target operationIds (`*` globs, `<originId>:` prefixes). With `only`, the union is graded and
	 * every other operation is support — called, never graded. Omit both for a full run.
	 */
	ops?: string[]
	/** Named profiles this run can select between. `"full"` and `"cheap"` exist without an entry. */
	profiles?: Record<string, ProfileSpec>
	/** Active profile by name. Defaults to `"full"` — every operation runs, today's behaviour. */
	profile?: string
	/** Stops the run between checks; teardown and the result still follow. */
	signal?: AbortSignal
	/** Per-run token for values that must not collide across runs. Random when omitted. */
	nonce?: string
	/** Leaves created records in place. Useful when inspecting a failure by hand. */
	keepFixtures?: boolean
	/** Returns the credential values the run held as `RunResult.credentials`; the CLI writes them outside the output directory. */
	keepCredentials?: boolean
	/** Requests allowed in flight at once, across the whole run. */
	maxInFlight?: number
	/** Paces requests per category. Checked before `x-rate-limit` tags for the same request. */
	rateLimits?: RateLimitSpec[]
	/** Requests per second to `baseUrl` in all; see `OatConfig.maxRps`. */
	maxRps?: number
	/** Non-fatal notes, such as an upload path that matched no file. The CLI prints them; unset, they are dropped. */
	warn?: (message: string) => void
	/** Live status. Called on phase/entity/check/request; the CLI prints a heartbeat from this. */
	onProgress?: ProgressHandler
	/** Extra hosts with their own OpenAPI. Auth stays on the primary. */
	origins?: OriginSpec[]
	/** Patches to the document, applied before oat reads it; see `OatConfig.overlay`. */
	overlay?: SpecOverlay
	/** The only operationIds oat may call; see `OatConfig.allow`. */
	allow?: string[]
	/** See `OatConfig.fence`. */
	fence?: { failRun?: boolean }
	/** See `OatConfig.teardown`. */
	teardown?: { verify?: boolean }
	/** Known findings, as `oat baseline` writes them; see `OatConfig.baseline`. */
	baseline?: BaselineFile
	/** Where the backend says which build it is; see `OatConfig.targetVersion`. */
	targetVersion?: TargetVersionSpec
	/** Declared flows for operations the matrix cannot reach. */
	scenarios?: Scenario[]
	/** Backoff for `resolveOutOfBand` / `resolvePrincipalAuth`. */
	outOfBand?: OutOfBandConfig
	/** How much of the payload catalog to send; see `OatConfig.payloads`. */
	payloads?: PayloadPolicy
	/** Checks switched on that do not run by default; see `OatConfig.checks`. */
	checks?: CheckSwitches
	/** Skip `teardownPrincipal` — used when this run is a secondary origin sharing accounts. */
	skipPrincipalTeardown?: boolean
	/**
	 * Set when this run is a secondary origin's: the primary run's store, whose principals are already
	 * signed in, and the origin's `security` mapping. The primary validated the config against this
	 * document, and the primary revokes what the store minted.
	 */
	sharedCredentials?: { store: CredentialStore; mapping: Readonly<Record<string, string>> }
	/** Global filter catalog defaults, and the filter grammar when oat cannot infer it. */
	query?: QueryConfig
	/** Per-entity overlays. */
	entities?: Record<string, EntityConfig>
	/**
	 * Persist every exchange under this run dir (`exchanges.jsonl`, `exchanges/`, `blobs/`).
	 * Omit to leave the journal off. The CLI decides the default from the profile.
	 */
	exchangeDir?: string
	/**
	 * How much of the transcript's bodies each client keeps in memory (default 32 MiB), and where it
	 * spools the rest, encrypted (default the system's temporary directory). Removed when the run ends.
	 */
	transcript?: SpoolOptions
	network?: {
		retries?: number
		waitMs?: number
		/** Per-attempt abort. Default 180_000. `0` waits for the socket. */
		requestTimeoutMs?: number
		/** The transport every request goes through. The global `fetch` unless given, e.g. an in-process app's handler. */
		fetch?: typeof fetch
	}
}

/** One check's wall time on one entity. Its requests are counted from the transcript. */
export interface CheckTiming {
	check: string
	entity: string
	ms: number
}

export interface RunResult {
	findings: Finding[]
	model: SpecModel
	client: Client
	entitiesTested: string[]
	checksRun: string[]
	/** Checks that never ran, and what each needed. A quiet run is only meaningful alongside it. */
	checksSkipped: Array<{ check: string; entity: string; needs: string }>
	/**
	 * Checks that did not run because something they depend on was already reported broken.
	 *
	 * Recorded rather than dropped for the same reason skips are: suppression is correct — one
	 * root cause should produce one finding — but a suppressed check has *not* passed, and a
	 * report that shows only the root cause invites the reader to believe everything downstream
	 * was verified. It was not, and it must be re-run once the cause is fixed.
	 */
	checksSuppressed: Array<{ check: string; entity: string; because: string }>
	/**
	 * Checks a targeted run did not run on an entity because none of their subjects is a target.
	 * Neither run nor skipped: the check could apply, this run was not asked to grade it.
	 */
	checksOutOfScope: Array<{ check: string; entity: string }>
	/** Checks that ran but could not reach a verdict — see `Inconclusive`. */
	inconclusive: Inconclusive[]
	/** How long each check took on each entity, start to finish. */
	checkTimings: CheckTiming[]
	/** What passing checks observed about policies the document leaves open. */
	checkNotes: Array<{ check: string; entity: string; note: string }>
	/** Name of the profile that ran — `"full"` unless `--profile` / `config.profile` said otherwise. */
	profile: string
	/** Operations a profile excluded, and why. Each also has a matching `profile.skip` gap finding. */
	profileExclusions: Array<{ entity: string; operationId: string; reason: string }>
	/** What this run graded, per operation — targets only when targeted, every operation when full. */
	scope: ScopeReport
	created: number
	teardown: TeardownReport | null
	/** Baseline entries no finding matched any more. Absent with no baseline. */
	baseline?: { fixed: BaselineEntry[] }
	/** The build this run tested, or why it could not be read. Absent when not configured. */
	targetVersion?: TargetVersion
	/** Requests `hooks.beforeRequest` refused, and whether that alone fails the run. Absent with no hook. */
	fenced?: { requests: FencedRequest[]; failRun: boolean }
	/**
	 * The principals as the run left them, with no credential value — written to
	 * `<outDir>/<datetime>/principals.json` by the CLI.
	 */
	principals: PersistedPrincipal[]
	/** The credential values the run held, with `keepCredentials` only. */
	credentials?: KeptCredential[]
	/** Set when the run was stopped before every entity was tested. */
	interrupted?: boolean
	/** Journal size when `exchangeDir` was set. */
	exchanges?: { count: number }
	/** Set when `fetch` never got an HTTP status — the run names the kind instead of crashing. */
	network?: {
		kind: NetworkKind
		attempts: number
		waitedMs: number
		incomplete: boolean
		url: string
	}
}
