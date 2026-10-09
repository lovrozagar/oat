/**
 * Run orchestrator: model → world → checks → findings.
 *
 * The world is seeded once and outlives every check. A seeding failure is recorded once and
 * everything downstream is reported BLOCKED against that single cause, rather than re-failing
 * per case — which is what made prior attempts produce dozens of failures from one broken fixture.
 */

import { randomBytes } from "node:crypto"
import { buildModel, type EntityModel, type OperationModel, type SpecModel, operationResolver } from "../spec/graph.ts"
import { dereference, documentDefs, loadSpec } from "../spec/load.ts"
import type {
	EntityConfig,
	Hooks,
	OriginSpec,
	OutOfBandConfig,
	Principal,
	ProfileSpec,
	QueryCapabilities,
	RateLimitSpec,
	Uploads,
} from "../config/define-config.ts"
import { type OriginClient, createPrincipal, type PrincipalRuntime } from "./auth.ts"
import { createExchangeJournal } from "./exchanges.ts"
import {
	DEFAULT_NETWORK_RETRIES,
	DEFAULT_NETWORK_WAIT_MS,
	NetworkError,
	type NetworkKind,
	createNetworkGate,
	describeNetworkFailure,
	isNetworkError,
	probeOrigin,
	resolveRequestTimeoutMs,
} from "./network.ts"
import { type BackoffConfig, resolveBackoff } from "./poll.ts"
import { type PersistedPrincipal, persistedToPrincipal, snapshotPrincipal } from "./principals.ts"
import { CHECKS, type Actor, type CheckContext } from "./checks.ts"
import { Client, type Exchange, type HttpHooks, type RequestOptions, type RequestStart } from "./client.ts"
import type { ProgressHandler, ProgressInflight, ProgressLast, ProgressSnapshot } from "./progress.ts"
import { type Finding, FindingCollector, type Inconclusive } from "./finding.ts"
import { reportFeatureGateSchemaDrift } from "./feature-gate.ts"
import { formatUniqueSets } from "../spec/extensions.ts"
import { excludedByProfile, resolveProfile } from "./profile.ts"
import {
	authStepOperationIds,
	buildScopeReport,
	createIsAuthProvisioned,
	GradeLedger,
	resolveTargetScope,
	type ScopeReport,
	staticSubjects,
	type TargetScope,
} from "./scope.ts"
import { buildRateLimitRules, RateLimiter } from "./rate-limit.ts"
import { resolveEntityCapabilities } from "./query-capabilities.ts"
import { Ledger, type Owner, type TeardownReport } from "./teardown.ts"
import { SchemaValidator } from "./validate.ts"
import { isOverflowError, overflowFrom } from "./fixture.ts"
import type { UploadContext } from "./upload.ts"
import {
	type Record_,
	type Scope,
	SeedError,
	fillPath,
	listExisting,
	probeCreateFixtures,
	resolvePathScope,
	seedCohort,
} from "./world.ts"

/* The principal shape is the public config's — one definition, checked in both places. */
export type PrincipalSpec = Principal

export interface RunOptions {
	spec: string
	baseUrl: string
	principals: PrincipalSpec[]
	hooks?: Hooks
	uploads?: Uploads
	/** Directory of the config file — pool globs are resolved from here. */
	configDir?: string
	roots?: Record<string, string>
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
	/** Per-run token for values that must not collide across runs. Random when omitted. */
	nonce?: string
	/** Leaves created records in place. Useful when inspecting a failure by hand. */
	keepFixtures?: boolean
	/** Requests allowed in flight at once, across the whole run. */
	maxInFlight?: number
	/** Paces requests per category. Checked before `x-rate-limit` tags for the same request. */
	rateLimits?: RateLimitSpec[]
	/** Live status. Called on phase/entity/check/request; the CLI prints a heartbeat from this. */
	onProgress?: ProgressHandler
	/** Extra hosts with their own OpenAPI. Auth stays on the primary. */
	origins?: OriginSpec[]
	/** Backoff for `resolveOutOfBand` / `resolvePrincipalAuth`. */
	outOfBand?: OutOfBandConfig
	/** Skip `teardownPrincipal` — used when this run is a secondary origin sharing accounts. */
	skipPrincipalTeardown?: boolean
	/** Global filter catalog defaults. */
	query?: QueryCapabilities
	/** Per-entity overlays. */
	entities?: Record<string, EntityConfig>
	/**
	 * Persist every exchange under this run dir (`exchanges.jsonl`, `exchanges/`, `blobs/`).
	 * Omit to leave the journal off. The CLI decides the default from the profile.
	 */
	exchangeDir?: string
	network?: {
		retries?: number
		waitMs?: number
		/** Per-attempt abort. Default 180_000. `0` waits for the socket. */
		requestTimeoutMs?: number
	}
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
	/** Name of the profile that ran — `"full"` unless `--profile` / `config.profile` said otherwise. */
	profile: string
	/** Operations a profile excluded, and why. Each also has a matching `profile.skip` gap finding. */
	profileExclusions: Array<{ entity: string; operationId: string; reason: string }>
	/** What this run graded, per operation — targets only when targeted, every operation when full. */
	scope: ScopeReport
	created: number
	teardown: TeardownReport | null
	/** Credentials as they stood after acquire — written to `<outDir>/<datetime>/principals.json` by the CLI. */
	principals: PersistedPrincipal[]
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

function readPointer(body: unknown, pointer: string): unknown {
	const path = pointer
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)
	let node: unknown = body
	for (const segment of path) {
		if (node === null || typeof node !== "object") return undefined
		node = (node as Record<string, unknown>)[segment]
	}
	return node
}

interface ResolvedPrincipal {
	id: string
	headers: () => Record<string, string>
	roots: Record<string, string>
	role: string | undefined
	rank: number
	inviteAs: string | undefined
	runtime?: PrincipalRuntime
}

function sameTenant(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
	if (keys.length === 0) return true
	return keys.every((key) => a[key] === b[key])
}

/**
 * Removes principals the run provisioned.
 *
 * Where a flow registers a throwaway account, the account itself is a fixture — and usually the
 * only handle that can remove everything it created, since per-record deletes are owner-scoped
 * and the credential dies with the run.
 */
async function teardownPrincipals(
	principals: Array<ResolvedPrincipal | undefined>,
	hooks: Hooks,
	findings: FindingCollector,
): Promise<void> {
	const teardown = hooks.teardownPrincipal
	const addresses = principals
		.map((principal) => principal?.runtime?.address)
		.filter((address): address is string => typeof address === "string" && address !== "")
	if (addresses.length === 0) return

	if (teardown === undefined) {
		findings.gap(
			"world.teardown",
			"principal",
			`${addresses.length} principal(s) provisioned by this run were not removed`,
			`oat registered ${addresses.join(", ")} to run this test and has no way to delete them. ` +
				"Supply a teardownPrincipal hook, or these accounts accumulate on every run.",
		)
		return
	}

	for (const principal of principals) {
		if (principal === undefined) continue
		const runtime = principal.runtime
		const address = runtime?.address
		if (runtime === undefined || typeof address !== "string" || address === "") continue
		try {
			await teardown(address, {
				credential: runtime.credential(),
				headers: principal.headers(),
			})
		} catch (error) {
			findings.gap(
				"world.teardown",
				"principal",
				`could not remove provisioned principal ${address}`,
				error instanceof Error ? error.message : String(error),
			)
		}
	}
}

/**
 * A 429 is a finding only when the request that drew it was demonstrably under a rate the
 * *document* declared — `rateLimitSource === "tag"` and the bucket had a free token, meaning oat
 * did not have to wait for one. A 429 against a config-supplied rate is the operator's own guess
 * about the environment, not a claim the API made, so it is paced around and never reported; a
 * 429 that only arrived after oat's own bucket made the request wait means oat's rate model was
 * too generous, which is oat's fault, not the backend's.
 *
 * Grouped by category rather than reported per request: the point is "the declared rate for X is
 * wrong", once, not a flood of identical findings for every request that category serves.
 */
function reportRateLimitViolations(client: Client, findings: FindingCollector): void {
	const byCategory = new Map<string, Exchange[]>()
	for (const exchange of client.transcript) {
		if (exchange.status !== 429) continue
		if (exchange.rateLimitSource !== "tag" || exchange.rateLimitHadRoom !== true) continue
		const category = exchange.rateLimitCategory ?? "unknown"
		const list = byCategory.get(category) ?? []
		list.push(exchange)
		byCategory.set(category, list)
	}
	for (const [category, exchanges] of byCategory) {
		findings.spec(
			"spec.declared-rate-limit-is-honoured",
			category,
			`the declared "${category}" rate limit is not honoured`,
			`${exchanges.length} request(s) to the "${category}" category returned 429 despite oat ` +
				"pacing them within the rate x-rate-limit declares — each had a free token in its own " +
				"bucket at the moment it was sent, so this is not oat outrunning its own model. Either " +
				`the declared rate is wrong, or the backend enforces a stricter one than "${category}" ` +
				"documents.",
			exchanges.slice(0, 3),
		)
	}
}

/**
 * Resolves a principal to something that can produce headers on demand.
 *
 * Static headers stay static; acquired credentials refresh themselves. Returning a function
 * rather than a snapshot is what lets a long run outlive a short-lived token — a five-minute TTL
 * would otherwise turn the back half of every run into spurious 401s.
 */
async function resolvePrincipal(
	principal: PrincipalSpec,
	model: SpecModel,
	client: Client,
	hooks: Hooks,
	outOfBand: BackoffConfig,
	originClients?: ReadonlyMap<string, OriginClient>,
): Promise<ResolvedPrincipal> {
	const configured = principal.roots ?? {}

	/* A principal without a flow authenticates by static header — a long-lived API key needs no
	 * acquisition at all, and forcing one would be ceremony. */
	if (principal.auth === undefined) {
		return {
			headers: () => principal.headers ?? {},
			id: principal.id,
			inviteAs: principal.inviteAs,
			rank: principal.rank ?? 0,
			role: principal.role,
			roots: configured,
		}
	}

	const runtime = await createPrincipal(principal.id, principal.auth, {
		client,
		hooks,
		model,
		outOfBand,
		principalId: principal.id,
		...(originClients === undefined ? {} : { originClients }),
	})

	/* A flow that provisions a tenant produces its own roots — the run then needs no fixture
	 * identifiers configured at all. */
	const discovered: Record<string, string> = {}
	for (const [param, key] of Object.entries(principal.rootsFromFlow ?? {})) {
		const value = runtime.scope[key]
		if (value !== undefined) discovered[param] = value
	}

	const headers = (): Record<string, string> => ({ ...principal.headers, ...runtime.headers() })
	client.bindAuth({
		headers,
		matches: (sent) => runtime.matches(sent),
		refreshIfStale: runtime.refreshIfStale,
	})

	return {
		headers,
		id: principal.id,
		inviteAs: principal.inviteAs,
		rank: principal.rank ?? 0,
		role: principal.role,
		roots: { ...discovered, ...configured },
		runtime,
	}
}

/** Reads whatever the list endpoint already returns, for degraded read-only coverage. */
async function readExisting(
	listOp: OperationModel,
	model: SpecModel,
	client: Client,
	headers: Record<string, string>,
	roots: Record<string, string>,
): Promise<{ records: Record_[]; scope: Record<string, string> }> {
	/* Seed with every known root, not only the list route's own parameters. Sibling routes for
	 * the same entity are often scoped differently — a global list beside a tenant-scoped item
	 * route — and a scope built from the list alone leaves those unresolvable. */
	const scope: Record<string, string> = { ...roots }
	for (const param of listOp.pathParams) {
		if (scope[param] === undefined) return { records: [], scope }
	}
	const records = await listExisting(listOp, model, client, headers, scope)
	return { records, scope }
}

export async function run(options: RunOptions): Promise<RunResult> {
	const startedAt = Date.now()
	const findings = new FindingCollector()
	const profile = resolveProfile(options.profile, options.profiles)
	const profileExclusions: Array<{ entity: string; operationId: string; reason: string }> = []
	let last: ProgressLast | undefined
	const inflight = new Set<RequestStart>()
	let currentPhase: ProgressSnapshot["phase"] = "load"
	let currentEntity: string | undefined
	let currentCheck: string | undefined
	let currentEntityIndex: number | undefined
	let entityTotal: number | undefined
	const defectCount = (): number =>
		findings.findings.filter((f) => f.verdict !== "BLOCKED" && f.verdict !== "COVERAGE_GAP").length
	const oldestInflight = (): ProgressInflight | undefined => {
		let oldest: RequestStart | undefined
		for (const probe of inflight) {
			if (oldest === undefined || probe.at < oldest.at) oldest = probe
		}
		if (oldest === undefined) return undefined
		const displayed: ProgressInflight = { at: oldest.at, method: oldest.method, url: oldest.url }
		if (oldest.requestId !== "") displayed.requestId = oldest.requestId
		displayed.requestBytes = oldest.requestBytes
		return displayed
	}
	let client!: Client
	const requestCount = (): number => client.transcript.length
	const snapshot = (extra?: {
		message?: string
		requests?: number
		inflight?: ProgressInflight
		omitInflight?: boolean
	}): ProgressSnapshot => {
		const snap: ProgressSnapshot = {
			elapsedMs: Date.now() - startedAt,
			findings: defectCount(),
			phase: currentPhase,
			requests: extra?.requests ?? requestCount(),
		}
		if (currentCheck !== undefined) snap.check = currentCheck
		if (currentEntity !== undefined) snap.entity = currentEntity
		if (currentEntityIndex !== undefined) snap.entityIndex = currentEntityIndex
		if (entityTotal !== undefined) snap.entityTotal = entityTotal
		if (extra?.message !== undefined) snap.message = extra.message
		if (last !== undefined) snap.last = last
		if (extra?.omitInflight !== true) {
			const live = extra?.inflight ?? oldestInflight()
			if (live !== undefined) snap.inflight = live
		}
		return snap
	}
	const publish = (snap: ProgressSnapshot): void => {
		options.onProgress?.(snap)
	}
	const tick = (partial: {
		phase: ProgressSnapshot["phase"]
		entity?: string | undefined
		entityIndex?: number | undefined
		entityTotal?: number | undefined
		check?: string | undefined
		message?: string | undefined
		requests?: number | undefined
	}): void => {
		currentPhase = partial.phase
		if (partial.entity !== undefined) currentEntity = partial.entity
		if (partial.entityIndex !== undefined) currentEntityIndex = partial.entityIndex
		if (partial.entityTotal !== undefined) entityTotal = partial.entityTotal
		if (partial.check !== undefined) currentCheck = partial.check
		publish(
			snapshot({
				...(partial.message === undefined ? {} : { message: partial.message }),
				...(partial.requests === undefined ? {} : { requests: partial.requests }),
			}),
		)
	}

	tick({ message: options.spec, phase: "load", requests: 0 })
	const raw = await loadSpec(options.spec, options.baseUrl, {
		onWait: (info) => {
			tick({
				message: `waiting for network (${info.kind}, ${Math.ceil(info.remainingMs / 1000)}s left)`,
				phase: "load",
				requests: 0,
			})
		},
		...(options.network?.retries === undefined ? {} : { retries: options.network.retries }),
		...(options.network?.waitMs === undefined ? {} : { waitMs: options.network.waitMs }),
		...requestTimeoutOpt(options.network?.requestTimeoutMs),
	})
	const { doc } = dereference(raw)
	const model = buildModel(doc)
	try {
		probeCreateFixtures(model)
	} catch (error) {
		if (!isOverflowError(error)) throw error
	}
	const hooks = options.hooks ?? {}
	const authCreates = authStepOperationIds(options.principals)
	const rateLimiter = new RateLimiter(buildRateLimitRules(model, options.rateLimits))
	const remember = (exchange: Exchange): void => {
		last = {
			at: exchange.at,
			durationMs: exchange.durationMs,
			method: exchange.method,
			requestBytes: exchange.requestBytes,
			requestId: exchange.requestId,
			responseBytes: exchange.responseBytes,
			status: exchange.status,
			url: exchange.url,
			...(exchange.network === undefined ? {} : { network: exchange.network.kind }),
		}
	}
	const journal = options.exchangeDir === undefined ? null : createExchangeJournal(options.exchangeDir)
	const onExchange = async (exchange: Exchange): Promise<void> => {
		remember(exchange)
		if (journal !== null) {
			try {
				/* The exchange names its own check and entity: a shared "current check" was wrong
				 * whenever checks ran concurrently, and journaled a whole batch under the last one. */
				await journal.record(exchange, {
					...(exchange.check === undefined ? {} : { check: exchange.check }),
					...(exchange.subject === undefined ? {} : { entity: exchange.subject }),
					phase: currentPhase,
				})
			} catch {
				/* journal is observability — a write error must not fail the request */
			}
		}
		publish(snapshot({ omitInflight: true }))
		const remaining = oldestInflight()
		if (remaining !== undefined) publish(snapshot({ inflight: remaining }))
	}
	const httpHooks: HttpHooks = {
		end(probe) {
			inflight.delete(probe)
		},
		start(probe) {
			inflight.add(probe)
			const displayed: ProgressInflight = { at: probe.at, method: probe.method, url: probe.url }
			if (probe.requestId !== "") displayed.requestId = probe.requestId
			displayed.requestBytes = probe.requestBytes
			publish(snapshot({ inflight: displayed }))
		},
	}
	const networkGate = createNetworkGate({
		onWait: (info) => {
			tick({
				message: `waiting for network (${info.kind}, ${Math.ceil(info.remainingMs / 1000)}s left)`,
				phase: currentPhase,
				requests: requestCount(),
			})
		},
		probe: () => probeOrigin(options.baseUrl),
		waitBudgetMs: options.network?.waitMs ?? DEFAULT_NETWORK_WAIT_MS,
	})
	let networkOutcome: RunResult["network"]
	const noteNetwork = (error: NetworkError, where: string): void => {
		if (networkOutcome !== undefined) return
		networkOutcome = {
			attempts: error.attempts,
			incomplete: true,
			kind: error.kind,
			url: error.url,
			waitedMs: networkGate.waitedMs,
		}
		findings.gap(
			"net.unreachable",
			where,
			`network down (${error.kind})`,
			describeNetworkFailure(error, networkGate.waitedMs),
		)
	}
	const networkClient = {
		awaitRecovery: (error: NetworkError) => networkGate.awaitRecovery(error),
		retries: options.network?.retries ?? DEFAULT_NETWORK_RETRIES,
		...requestTimeoutOpt(options.network?.requestTimeoutMs),
	}
	client = new Client(
		options.baseUrl,
		options.globalHeaders ?? {},
		options.maxInFlight ?? 4,
		onExchange,
		rateLimiter,
		httpHooks,
		networkClient,
	)
	if (hooks.resolveHeaders !== undefined) client.setResolveHeaders(hooks.resolveHeaders)
	client.setOperationResolver(operationResolver(model))
	const validator = new SchemaValidator(model.defs)
	const ledger = new Ledger()
	const seed = options.seed ?? 1
	/* Fresh per run: the seed reproduces a run, the nonce keeps two runs' records apart. */
	const nonce = options.nonce ?? randomBytes(4).toString("hex")
	const outOfBand = resolveBackoff(options.outOfBand)

	if (options.principals[0] === undefined) throw new Error("oat: at least one principal is required")

	const originClients = await loadOriginClients(
		options.origins ?? [],
		hooks,
		options.maxInFlight ?? 4,
		options.globalHeaders ?? {},
		onExchange,
		httpHooks,
		networkClient,
	)
	/* Resolved before any principal signs up: a typo in --ops must cost nothing. */
	const runScope: TargetScope = resolveTargetScope(model, {
		...(options.ops === undefined ? {} : { ops: options.ops }),
		...(options.only === undefined ? {} : { only: options.only }),
		authCreates,
		exclusion: { profile: profile.name, reason: (op) => excludedByProfile(op, profile.spec) },
		origins: new Map([...originClients].map(([id, origin]) => [id, origin.model])),
	})
	const grades = new GradeLedger()
	tick({
		message:
			runScope.mode === "full"
				? "scope: full"
				: `scope: targeted · ${runScope.targets.size} operation(s) · ${runScope.entities.length} entit${runScope.entities.length === 1 ? "y" : "ies"}`,
		phase: "load",
		requests: client.transcript.length,
	})
	const scopeReport = (): ScopeReport =>
		buildScopeReport({
			authCreates,
			baseUrl: options.baseUrl,
			findings: findings.findings,
			inconclusive: findings.inconclusive,
			ledger: grades,
			model,
			scope: runScope,
			transcript: client.transcript,
		})
	const uploads: UploadContext = {
		seed,
		...(options.uploads === undefined ? {} : { uploads: options.uploads }),
		...(options.configDir === undefined ? {} : { configDir: options.configDir }),
		...(hooks.resolveUpload === undefined ? {} : { resolveUpload: hooks.resolveUpload }),
		...(hooks.resolveInput === undefined ? {} : { resolveInput: hooks.resolveInput }),
	}
	const worldUploads = (seedOffset = 0): UploadContext =>
		seedOffset === 0 ? uploads : { ...uploads, seed: seed + seedOffset }
	const resolved: ResolvedPrincipal[] = []
	try {
		for (const principal of options.principals) {
			resolved.push(
				await resolvePrincipal(
					principal,
					model,
					client.view({ purpose: "auth" }),
					hooks,
					outOfBand,
					originClients.size === 0 ? undefined : originClients,
				),
			)
		}
	} catch (error) {
		if (!isNetworkError(error)) throw error
		noteNetwork(error, "auth")
		return {
			checksOutOfScope: [],
			checksRun: [],
			checksSkipped: [],
			checksSuppressed: [],
			client,
			created: 0,
			entitiesTested: [],
			findings: findings.findings,
			inconclusive: findings.inconclusive,
			model,
			principals: [],
			profile: profile.name,
			profileExclusions,
			scope: scopeReport(),
			teardown: null,
			...(journal === null ? {} : { exchanges: { count: journal.count } }),
			...(networkOutcome === undefined ? {} : { network: networkOutcome }),
		}
	}
	tick({
		message: `${resolved.length} principal(s)`,
		phase: "auth",
		requests: client.transcript.length,
	})
	/* Every exchange names the principal whose credential it carried. */
	client.setPrincipalResolver(
		(sent) =>
			resolved.find((principal) => {
				const own = principal.headers()
				return Object.keys(own).length > 0 && Object.entries(own).every(([key, value]) => sent[key] === value)
			})?.id,
	)
	const alpha = resolved[0] as ResolvedPrincipal
	const ownerOf = (principal: ResolvedPrincipal): Owner => ({ headers: principal.headers, id: principal.id })
	const alphaOwner = ownerOf(alpha)
	/* A record a principal created and could not remove itself — a member cannot delete — may be
	 * removed by a stronger principal of the same tenant, and by nobody else. */
	const fallbackDeleters = (owner: Owner): Owner[] => {
		const creator = resolved.find((principal) => principal.id === owner.id)
		if (creator === undefined) return []
		return resolved
			.filter((principal) => principal.id !== creator.id && sameTenant(principal.roots, creator.roots))
			.sort((a, b) => b.rank - a.rank)
			.map(ownerOf)
	}
	const recorder =
		(owner: Owner) =>
		(entity: string, id: string, values: Record<string, string>): void => {
			ledger.record(entity, id, values, owner)
		}
	/* Isolation peer: first principal whose roots are a different tenant — not "whoever is
	 * second in the array". A same-tenant viewer sitting at index 1 must not steal that slot. */
	const peer = resolved.slice(1).find((candidate) => !sameTenant(alpha.roots, candidate.roots))

	const entitiesTested: string[] = []
	const checksRun = new Set<string>()
	const checksSkipped: Array<{ check: string; entity: string; needs: string }> = []
	const checksSuppressed: Array<{ check: string; entity: string; because: string }> = []
	const checksOutOfScope: Array<{ check: string; entity: string }> = []

	const profileExcludes = (operationId: string): boolean => {
		const op = model.byOperationId.get(operationId)
		return op !== undefined && excludedByProfile(op, profile.spec) !== null
	}
	const excludedIds = new Set<string>()
	const excludeOp = (entity: EntityModel, op: OperationModel | undefined): boolean => {
		if (op === undefined) return false
		const reason = excludedByProfile(op, profile.spec)
		if (reason === null) return false
		if (excludedIds.has(op.operationId)) return true
		excludedIds.add(op.operationId)
		profileExclusions.push({ entity: entity.name, operationId: op.operationId, reason })
		findings
			.attributed([op.operationId])
			.gap(
				"profile.skip",
				entity.name,
				`${op.operationId} excluded by profile "${profile.name}"`,
				`${reason}, under --profile ${profile.name}. Checks that depend on this operation stand ` +
					"down rather than run against data oat did not create through it.",
			)
		return true
	}

	const testEntity = async (entity: EntityModel): Promise<void> => {
		const listOp = model.byOperationId.get(entity.list ?? "")
		const createOp = model.byOperationId.get(entity.create ?? "")
		if (listOp === undefined) return
		if (networkGate.exhausted) return
		/* Targets this entity's checks can grade. Seeding findings land on them: under --ops a seed
		 * that fails leaves exactly these ungraded, and the report has to say which. */
		const entityTargets =
			runScope.mode === "full"
				? createOp === undefined
					? []
					: [createOp.operationId]
				: [...staticSubjects(entity, model)].filter((id) => runScope.inScope(id))
		const entityFindings = entityTargets.length === 0 ? findings : findings.attributed(entityTargets)
		const inviteOnly = entity.invite !== null && createOp === undefined
		const authProvisioned = createOp !== undefined && createIsAuthProvisioned(createOp, authCreates)
		if (createOp === undefined && !inviteOnly) return
		if (excludeOp(entity, listOp)) {
			/* No fallback for a list route itself: every other check on this entity is reached
			 * through it, so its exclusion is the whole entity's, not one operation's. */
			return
		}
		currentEntity = entity.name
		currentCheck = undefined
		currentPhase = "seed"
		/* Everything this entity's world-building sends is seeding, attributed to the entity. */
		const seeding = client.view({ purpose: "seed", subject: entity.name })
		tick({
			entity: entity.name,
			entityIndex: currentEntityIndex,
			entityTotal,
			message: "seeding",
			phase: "seed",
			requests: client.transcript.length,
		})

		for (const principal of resolved) await principal.runtime?.refreshIfStale()
		const rootValues = { ...options.roots, ...alpha.roots }
		let scope: Scope
		let records: Record_[]
		let degraded = false
		let uniqueAdopted = false
		if (createOp !== undefined && excludeOp(entity, createOp)) {
			/* Same fallback a failed create takes below: read-only coverage against whatever
			 * already exists beats no coverage, and it is exactly the state most likely to hide a
			 * read-path bug. The gap finding excludeOp already reported names the reason. */
			const existing = await readExisting(listOp, model, seeding, alpha.headers(), {
				...options.roots,
				...alpha.roots,
			})
			if (existing.records.length === 0) {
				entityFindings.blocked(
					"profile.skip",
					entity.name,
					`could not test "${entity.name}"`,
					`create is excluded by profile "${profile.name}" and the list route returned no ` +
						"existing records to fall back on.",
				)
				return
			}
			scope = { created: [], values: existing.scope }
			records = existing.records
			degraded = true
		} else if (createOp === undefined || authProvisioned) {
			/* Invite is not a fixture create; register / x-fresh-principal already ran in auth.
			 * The invite check is the only thing that POSTs a grant, and it uses inviteAs. */
			const existing = await readExisting(listOp, model, seeding, alpha.headers(), {
				...options.roots,
				...alpha.roots,
			})
			scope = { created: [], values: { ...rootValues, ...existing.scope } }
			records = existing.records
			degraded = true
		} else {
			try {
				scope = await resolvePathScope(createOp, model, seeding, {
					authHeaders: alpha.headers,
					onCreate: recorder(alphaOwner),
					nonce,
					roots: rootValues,
					seed,
					uploads,
				})
				/* Carry every known root, not only what the create route happened to need. Sibling
				 * routes for one entity are frequently scoped differently — a global create beside
				 * a tenant-scoped item route — and a scope built from create alone leaves those
				 * unresolvable, which shows up as a wall of "could not complete" gaps. */
				scope.values = { ...rootValues, ...scope.values }
				const cohort = await seedCohort(
					createOp,
					model,
					seeding,
					{
						authHeaders: alpha.headers,
						...(options.cohortSize === undefined ? {} : { cohortSize: options.cohortSize }),
						onCreate: recorder(alphaOwner),
						nonce,
						roots: rootValues,
						seed,
						uploads,
					},
					scope,
				)
				if (cohort.uniqueGap !== undefined) {
					entityFindings.gap("world.seed", entity.name, cohort.uniqueGap, cohort.uniqueGap)
				}
				if (cohort.adopted === true) {
					/* Plan limit after an effect already created the row: keep the id so children
					 * (row after extract→table) can seed, but do not assert write-path oracles
					 * against a body oat never submitted. */
					entityFindings.gap(
						"world.seed",
						entity.name,
						`seeding "${entity.name}" hit a plan limit; using an existing same-tenant record`,
						`${createOp.operationId} returned a plan-limit refusal and the list already ` +
							"had a record — likely an earlier x-effects create. Write-path checks stand " +
							"down rather than treat payment_required as a backend defect.",
					)
					/* Adopted, not created: what oat did create was recorded as it happened, and
					 * this record is somebody else's to keep. */
					records = cohort.records
					degraded = true
				} else if (cohort.uniqueAdopted === true) {
					/* Unique 409 on the first variant with a same-tenant list: adopt like 402,
					 * but unique-conflict checks still run against that row. Write-path oracles
					 * that need a body oat submitted stay skipped. The seed 409 is not the
					 * unique check passing — that check is the explicit second POST. */
					entityFindings.gap(
						"world.seed",
						entity.name,
						`seeding "${entity.name}" could not insert because of x-unique`,
						`${createOp.operationId} returned 409 and the list already had a record. ` +
							`x-unique: ${formatUniqueSets(createOp.unique)}. The create could not insert; ` +
							"unique-conflict checks still run against that row. Write-path oracles that " +
							"need a body oat submitted stand down.",
					)
					records = cohort.records
					degraded = true
					uniqueAdopted = true
				} else if (cohort.featureGate !== null) {
					/* Same degradation a profile-excluded create takes: the tag said this
					 * principal cannot create the row, so a correct 403 is coverage, not a
					 * seed defect. The 403 body still has to match the documented schema. */
					reportFeatureGateSchemaDrift(
						entityFindings,
						validator,
						createOp,
						model.rawOperations.get(createOp.operationId),
						cohort.featureGate.exchange,
						entity.name,
					)
					entityFindings.gap(
						"world.seed",
						entity.name,
						`seeding "${entity.name}" is gated by ${cohort.featureGate.detail}`,
						`${cohort.featureGate.detail}. Checks that need a row oat created stand down ` +
							"rather than treat the documented 403 as a defect.",
					)
					const existing = await readExisting(listOp, model, seeding, alpha.headers(), {
						...options.roots,
						...alpha.roots,
					})
					if (existing.records.length === 0) {
						entityFindings.blocked(
							"world.seed",
							entity.name,
							`could not test "${entity.name}"`,
							`${cohort.featureGate.detail} and the list route returned no existing ` + "records to fall back on.",
						)
						return
					}
					scope = { created: [], values: existing.scope }
					records = existing.records
					degraded = true
				} else {
					/* Every ancestor and cohort record was ledgered as it was created, in creation
					 * order — the unwind reverses it, so children go before their parents. */
					records = cohort.records
				}
			} catch (error) {
				if (isNetworkError(error)) {
					noteNetwork(error, entity.name)
					return
				}
				if (isOverflowError(error)) {
					const overflow = overflowFrom(error, createOp.operationId)
					entityFindings.gap("world.seed", entity.name, overflow.message, overflow.message)
					const existing = await readExisting(listOp, model, seeding, alpha.headers(), {
						...options.roots,
						...alpha.roots,
					})
					if (existing.records.length === 0) {
						entityFindings.blocked("world.seed", entity.name, `could not seed "${entity.name}"`, overflow.message)
						return
					}
					scope = { created: [], values: existing.scope }
					records = existing.records
					degraded = true
				} else {
					const cause = error instanceof SeedError ? error.cause_ : "unknown"
					const status = error instanceof SeedError ? error.status : undefined
					const message = error instanceof Error ? error.message : String(error)
					const failedOp = (error instanceof SeedError ? error.operationId : undefined) ?? createOp.operationId
					const evidence =
						error instanceof SeedError && error.exchange !== undefined
							? [error.exchange]
							: client.transcript.filter((e) => e.status >= 500).slice(-1)
					/* Under --ops a create nobody targeted is support. Its failure leaves the targets
					 * ungraded — blocked, with the evidence — but it is not what this run was asked to
					 * judge, so it is not reported as a defect of its own. */
					const supportFailed = runScope.mode === "targeted" && !runScope.inScope(failedOp)

					/* A create that fails with 5xx is not a fixture problem — it is the defect.
					 * Reporting it as merely "blocked" buries the most serious thing oat found. */
					if (status !== undefined && status >= 500 && !supportFailed) {
						findings
							.attributed([failedOp])
							.backend(
								"create.does-not-error",
								entity.name,
								`creating a "${entity.name}" fails with a server error`,
								`${message}. The request body was generated from the documented schema, so ` +
									"either the handler rejects input the document permits, or it is failing " +
									"outright. Everything downstream of this entity is untestable until it is " +
									"fixed.",
								evidence,
							)
					}

					/* Fall back to whatever already exists. A backend whose create is broken can still
					 * have a working list, and read-only coverage beats no coverage — this is exactly
					 * the state in which a read-path bug is most likely to be sitting undiscovered. */
					const existing = await readExisting(listOp, model, seeding, alpha.headers(), {
						...options.roots,
						...alpha.roots,
					})
					if (existing.records.length === 0) {
						entityFindings.blocked(
							"world.seed",
							entity.name,
							`could not seed "${entity.name}"`,
							supportFailed ? `support operation ${failedOp} failing: ${message}` : `${cause}: ${message}`,
							evidence,
						)
						return
					}

					entityFindings.gap(
						"world.seed",
						entity.name,
						`seeding "${entity.name}" failed; running read-only checks against existing records`,
						`${cause}: ${message}. Write-path and lifecycle checks are skipped for this entity.`,
					)
					scope = { created: [], values: existing.scope }
					records = existing.records
					degraded = true
				}
			}
		}

		const actorOf = async (principal: ResolvedPrincipal, seedOffset: number): Promise<Actor> => {
			const roots = { ...options.roots, ...principal.roots }
			try {
				const next = await resolvePathScope(listOp, model, seeding, {
					authHeaders: principal.headers,
					/* Created as this principal, so removed as this principal. */
					onCreate: recorder(ownerOf(principal)),
					nonce,
					roots,
					seed: seed + seedOffset,
					uploads: worldUploads(seedOffset),
				})
				return {
					headers: principal.headers,
					id: principal.id,
					inviteAs: principal.inviteAs,
					rank: principal.rank,
					role: principal.role,
					roots,
					scope: { ...roots, ...next.values },
				}
			} catch {
				return {
					headers: principal.headers,
					id: principal.id,
					inviteAs: principal.inviteAs,
					rank: principal.rank,
					role: principal.role,
					roots,
					scope: roots,
				}
			}
		}

		const actors: Actor[] = [
			{
				headers: alpha.headers,
				id: alpha.id,
				inviteAs: alpha.inviteAs,
				rank: alpha.rank,
				role: alpha.role,
				roots: { ...options.roots, ...alpha.roots },
				scope: scope.values,
			},
		]
		for (let i = 1; i < resolved.length; i++) {
			const principal = resolved[i]
			if (principal === undefined) continue
			actors.push(await actorOf(principal, i))
		}
		const isolation = actors.find((actor) => !sameTenant(actors[0]?.roots ?? {}, actor.roots))
		const altScope = isolation?.scope
		const altAuth = isolation?.headers

		/*
		 * Anything a check creates is registered for teardown automatically.
		 *
		 * Several checks POST directly — replaying an idempotency key, probing a declared
		 * invalidation, sending a body that validation should have rejected — and those records
		 * were invisible to the ledger, so oat left them behind in the backend under test while
		 * reporting that it had cleaned up everything it made. Recording centrally rather than at
		 * each call site means a new check cannot forget: the wrapper sees every request.
		 */
		let createPath: string | undefined
		try {
			createPath = createOp === undefined ? undefined : fillPath(createOp.path, scope.values)
		} catch {
			createPath = undefined
		}
		/* Whoever sent the request owns what it created: matched on the credential it carried. */
		const ownerByHeaders = (sent: RequestOptions["headers"]): Owner => {
			const rendered = JSON.stringify(typeof sent === "function" ? sent() : (sent ?? {}))
			const match = resolved.find((principal) => JSON.stringify(principal.headers()) === rendered)
			return match === undefined ? alphaOwner : ownerOf(match)
		}
		const tracked = (base: Client): Client =>
			createOp === undefined || degraded
				? base
				: new Proxy(base, {
						get(target, property, receiver) {
							if (property !== "request") return Reflect.get(target, property, receiver)
							return async (
								method: string,
								path: string,
								options?: Parameters<Client["request"]>[2],
							): Promise<Exchange> => {
								const exchange = await target.request(method, path, options ?? {})
								if (method.toUpperCase() !== "POST" || exchange.status >= 300) return exchange
								/* Only this entity's own create makes one of its records. Any other 2xx
								 * POST carrying an `id` — an invite, an action — names something else, and
								 * on an integer-id API deleting by that number removes an unrelated row. */
								if (path !== createPath) return exchange
								const body = exchange.responseBody
								if (body === null || typeof body !== "object") return exchange
								const id = (body as Record<string, unknown>)[entity.identity ?? "id"]
								if (typeof id !== "string" && typeof id !== "number") return exchange
								ledger.record(entity.name, String(id), scope.values, ownerByHeaders(options?.headers))
								return exchange
							}
						},
					})

		const readOpModel = model.byOperationId.get(entity.read ?? "")
		const updateOpModel = model.byOperationId.get(entity.update ?? "")
		const deleteOpModel = model.byOperationId.get(entity.delete ?? "")
		/* Checked independently of `degraded`: a profile can exclude one write route on an entity
		 * whose create still ran cleanly, and that must not disable every other operation too. */
		const readExcluded = excludeOp(entity, readOpModel)
		const updateExcluded = excludeOp(entity, updateOpModel)
		const deleteExcluded = excludeOp(entity, deleteOpModel)
		const inviteOp = entity.invite === null ? undefined : model.byOperationId.get(entity.invite.invite)
		const inviteExcluded = excludeOp(entity, inviteOp)
		const invocable = (op: OperationModel): boolean => !excludeOp(entity, op)

		const entityQuery = options.entities?.[entity.name]?.query
		const capabilities = await resolveEntityCapabilities({
			tag: listOp.query,
			itemSchema: listOp.collection?.itemSchema ?? null,
			entityName: entity.name,
			scope: scope.values,
			model,
			client,
			auth: alpha.headers,
			...(options.query === undefined ? {} : { global: options.query }),
			...(entityQuery === undefined ? {} : { entity: entityQuery }),
			...(hooks.resolveQueryCapabilities === undefined ? {} : { hook: hooks.resolveQueryCapabilities }),
		})
		const query = listOp.query
		const queryForChecks =
			query === null
				? null
				: {
						...query,
						filterable: capabilities.filterable.map((field) => field.field),
						searchable: capabilities.searchable,
						selectable: capabilities.selectable,
						sortable: capabilities.sortable.map((field) => field.field),
					}

		const ctx: CheckContext = {
			actors,
			altAuth,
			altScope,
			/* Narrowed to targets: these are the subjects their checks invoke, and invoking an
			 * untargeted one is exactly the cost --ops exists to skip. */
			asyncOps: model.operations.filter(
				(op) => op.entity === entity.name && op.async !== null && invocable(op) && runScope.inScope(op.operationId),
			),
			effectOps: model.operations.filter(
				(op) => op.entity === entity.name && op.effects.length > 0 && invocable(op) && runScope.inScope(op.operationId),
			),
			waitOps: model.operations.filter(
				(op) => op.entity === entity.name && op.wait !== null && invocable(op) && runScope.inScope(op.operationId),
			),
			inScope: (op) => runScope.inScope(op.operationId),
			hooks,
			outOfBand,
			auth: alpha.headers,
			recordCreated: recorder(alphaOwner),
			...(alpha.runtime === undefined ? {} : { refreshIfStale: alpha.runtime.refreshIfStale }),
			client: tracked(client.view({ purpose: "assertion", subject: entity.name })),
			collectionKey: listOp.collection?.key ?? null,
			/* In degraded mode oat did not write these records, so it has no oracle for them —
			 * every write-path check must sit out rather than assert against data it did not
			 * create. A profile-excluded write route stands down the same way, independently. */
			createOp: degraded ? undefined : createOp,
			deleteOp: degraded || deleteExcluded ? undefined : deleteOpModel,
			entityName: entity.name,
			findings,
			identity: entity.identity ?? "id",
			invite: inviteExcluded ? null : entity.invite,
			capabilities,
			listOp,
			model,
			query: queryForChecks,
			readOp: readExcluded ? undefined : readOpModel,
			records,
			scope: scope.values,
			/* Taken from any operation on the entity, not just the list: authors naturally put
			 * x-soft-delete on the delete route, and a tag that exists but is only read from
			 * list made softdelete.absent-from-default-list stand down against a real document. */
			softDelete:
				model.operations.find((op) => op.entity === entity.name && op.softDelete !== null)?.softDelete ??
				listOp.softDelete,
			seed,
			nonce,
			updateOp: degraded || updateExcluded ? undefined : updateOpModel,
			uploads,
			validator,
			uniqueAdopted,
			uniqueSets: entity.unique ?? [],
			uniqueCreateOp:
				(entity.unique?.length ?? 0) > 0 && (!degraded || uniqueAdopted) && createOp !== undefined
					? createOp
					: undefined,
			uniqueUpdateOp:
				(entity.unique?.length ?? 0) > 0 &&
				updateOpModel !== undefined &&
				!updateExcluded &&
				(!degraded || uniqueAdopted)
					? updateOpModel
					: undefined,
		}

		entitiesTested.push(entity.name)

		/* Subjects each check grades on this entity: in scope, and not excluded by the profile. */
		const gradedBy = new Map<string, string[]>()
		const runOne = async (check: (typeof CHECKS)[number]): Promise<void> => {
			const graded = gradedBy.get(check.id) ?? []
			let judged: Set<string> | undefined
			const view: CheckContext = {
				...ctx,
				/* Its own client: every exchange names this check, even while a batch runs concurrently. */
				client: tracked(client.view({ check: check.id, purpose: "assertion", subject: entity.name })),
				...(graded.length === 0 ? {} : { findings: findings.attributed(graded) }),
				judged: (operationIds) => {
					judged ??= new Set()
					for (const id of operationIds) judged.add(id)
				},
			}
			checksRun.add(check.id)
			currentCheck = check.id
			currentPhase = "test"
			tick({
				check: check.id,
				entity: entity.name,
				entityIndex: currentEntityIndex,
				entityTotal,
				phase: "test",
				requests: client.transcript.length,
			})
			try {
				await check.run(view)
			} catch (error) {
				if (isNetworkError(error)) {
					noteNetwork(error, entity.name)
					return
				}
				view.findings.gap(
					check.id,
					entity.name,
					`check "${check.id}" could not complete`,
					error instanceof Error ? error.message : String(error),
				)
			}
			grades.graded(judged === undefined ? graded : graded.filter((id) => judged?.has(id) === true), check.id)
		}

		/* Cascade suppression: a check whose premise is already known broken would report a
		 * consequence, not a defect. One root cause, one finding. */
		/*
		 * Cascade suppression, transitively.
		 *
		 * A check whose premise is known broken reports a consequence, not a defect. The subtle
		 * part is that suppression has to propagate: if A is suppressed because B failed, then C
		 * — which depends on A — must be suppressed too. Consulting only *fired* findings misses
		 * this, because A never fired; it was skipped. C then runs against the same broken premise
		 * and reports the root cause a second time under its own name.
		 *
		 * So a check is suppressed when any dependency either failed outright or was itself
		 * suppressed, and the reason carried forward names the original cause rather than the
		 * intermediate link — which is what the reader has to fix.
		 */
		const suppressedBy = new Map<string, string>()
		const suppressed = (check: (typeof CHECKS)[number]): boolean => {
			for (const dependency of check.dependsOn ?? []) {
				const failed = findings.findings.some((f) => f.check === dependency && f.entity === entity.name)
				const inherited = suppressedBy.get(dependency)
				if (!failed && inherited === undefined) continue
				const because = failed ? dependency : (inherited as string)
				suppressedBy.set(check.id, because)
				checksSuppressed.push({ because, check: check.id, entity: entity.name })
				grades.suppress(gradedBy.get(check.id) ?? [], check.id)
				return true
			}
			return false
		}

		/*
		 * Read-only checks accumulate into a batch and fire together; a mutating check flushes the
		 * batch and then runs alone. A batch also flushes when the next check depends on something
		 * already inside it, so suppression never has to consult a finding that has not landed yet.
		 *
		 * This is where a live run's time actually goes — dozens of independent GETs against one
		 * entity, each paying full network latency for no reason.
		 */
		let batch: Array<(typeof CHECKS)[number]> = []
		const flush = async (): Promise<void> => {
			if (batch.length === 0) return
			const pending = batch
			batch = []
			await Promise.all(pending.map(runOne))
		}

		for (const check of CHECKS) {
			const graded = check.subjects(entity, model).filter((id) => runScope.inScope(id) && !profileExcludes(id))
			/* Out of scope is not a skip: the check could have run, this run was not asked to. */
			if (runScope.mode === "targeted" && graded.length === 0) {
				checksOutOfScope.push({ check: check.id, entity: entity.name })
				continue
			}
			gradedBy.set(check.id, graded)
			if (!check.applicable(ctx)) {
				/* Recorded, not dropped: on an API shaped unlike the fixture this is most of the
				 * suite, and a silent skip reads exactly like a clean result. */
				const needs = check.needs ?? "an unstated precondition"
				checksSkipped.push({ check: check.id, entity: entity.name, needs })
				grades.skipped(graded, needs)
				continue
			}
			if (check.mutates === true) {
				await flush()
				if (suppressed(check)) continue
				await runOne(check)
				continue
			}
			if (check.dependsOn?.some((d) => batch.some((queued) => queued.id === d)) === true) {
				await flush()
			}
			if (suppressed(check)) continue
			batch.push(check)
		}
		await flush()
	}

	/*
	 * Entities run in series. Checks inside an entity stay sequential because cascade
	 * suppression consults findings already reported for it — concurrent checks would let a
	 * root cause and its consequences race and both be reported. Nested graphs also couple
	 * entities: a child create in flight while a parent page-walk runs invents pagination
	 * findings, so there are no entity lanes.
	 */
	const queue = runScope.entities
	entityTotal = queue.length
	for (const [index, entity] of queue.entries()) {
		if (networkGate.exhausted) {
			const left = queue.length - index
			findings.blocked(
				"net.unreachable",
				"run",
				`skipped ${left} remaining entit${left === 1 ? "y" : "ies"}`,
				"network down",
			)
			break
		}
		currentEntityIndex = index + 1
		await testEntity(entity)
	}

	/* Unwind after every check has run, never per case: a check may legitimately depend on records
	 * another one created, and tearing down early turns that into a phantom defect. */
	currentPhase = "teardown"
	currentCheck = undefined
	tick({
		message: `${ledger.size} record(s)`,
		phase: "teardown",
		requests: client.transcript.length,
	})
	const teardown =
		options.keepFixtures === true || ledger.size === 0
			? null
			: await ledger.unwind(model, client.view({ purpose: "teardown" }), fallbackDeleters, (done, total, item) => {
					if (done % 25 !== 0 && done !== total) return
					tick({
						entity: item.entity,
						message: `${done}/${total} ${item.entity} ${item.id}`,
						phase: "teardown",
						requests: client.transcript.length,
					})
				})

	if (teardown !== null && teardown.unsupported.length > 0) {
		findings.gap(
			"world.teardown",
			teardown.unsupported.join(", "),
			"records created during the run could not be removed",
			`no delete operation is reachable for ${teardown.unsupported.join(", ")}, so this run left ` +
				"fixtures behind. Declare x-cleanup to name the route that removes them.",
		)
	}

	reportRateLimitViolations(client, findings)

	for (const principal of resolved) await principal.runtime?.refreshIfStale()
	const persisted = resolved.map((principal) =>
		snapshotPrincipal({
			headers: principal.headers,
			id: principal.id,
			roots: principal.roots,
			...(principal.role === undefined ? {} : { role: principal.role }),
			rank: principal.rank,
			...(principal.inviteAs === undefined ? {} : { inviteAs: principal.inviteAs }),
		}),
	)

	const coverage = scopeReport()
	if ((options.origins ?? []).length > 0 && options.skipPrincipalTeardown !== true) {
		await runSecondaryOrigins(
			options,
			persisted,
			findings,
			checksRun,
			checksSkipped,
			checksSuppressed,
			checksOutOfScope,
			entitiesTested,
			runScope,
			coverage,
		)
	}

	if (options.skipPrincipalTeardown !== true) {
		await teardownPrincipals(resolved, hooks, findings)
	}

	tick({
		message: "done",
		phase: "done",
		requests: client.transcript.length,
	})

	return {
		checksOutOfScope,
		checksRun: [...checksRun].sort(),
		checksSkipped,
		checksSuppressed,
		inconclusive: findings.inconclusive,
		client,
		created: ledger.size,
		entitiesTested,
		findings: findings.findings,
		model,
		principals: persisted,
		profile: profile.name,
		profileExclusions,
		scope: coverage,
		teardown,
		...(journal === null ? {} : { exchanges: { count: journal.count } }),
		...(networkOutcome === undefined ? {} : { network: networkOutcome }),
	}
}

function requestTimeoutOpt(value: number | undefined): { requestTimeoutMs: number } | Record<string, never> {
	const timeoutMs = resolveRequestTimeoutMs(value)
	return timeoutMs === undefined ? {} : { requestTimeoutMs: timeoutMs }
}

async function loadOriginClients(
	origins: OriginSpec[],
	hooks: Hooks,
	maxInFlight: number,
	globalHeaders: Record<string, string>,
	onExchange?: (exchange: Exchange) => void,
	httpHooks?: HttpHooks,
	network?: ConstructorParameters<typeof Client>[6],
): Promise<Map<string, OriginClient>> {
	const map = new Map<string, OriginClient>()
	for (const origin of origins) {
		const raw = await loadSpec(origin.spec, origin.baseUrl)
		const { doc } = dereference(raw)
		const originModel = buildModel(doc)
		const originClient = new Client(
			origin.baseUrl,
			globalHeaders,
			maxInFlight,
			onExchange,
			undefined,
			httpHooks,
			network,
		)
		if (hooks.resolveHeaders !== undefined) originClient.setResolveHeaders(hooks.resolveHeaders)
		map.set(origin.id, { client: originClient, model: originModel })
	}
	return map
}

async function runSecondaryOrigins(
	options: RunOptions,
	persisted: PersistedPrincipal[],
	findings: FindingCollector,
	checksRun: Set<string>,
	checksSkipped: Array<{ check: string; entity: string; needs: string }>,
	checksSuppressed: Array<{ check: string; entity: string; because: string }>,
	checksOutOfScope: Array<{ check: string; entity: string }>,
	entitiesTested: string[],
	runScope: TargetScope,
	coverage: ScopeReport,
): Promise<void> {
	for (const origin of options.origins ?? []) {
		/* Targets were resolved against every origin up front; an origin none of them name has
		 * nothing to grade, and running it anyway is the cost --ops exists to skip. */
		const originOps = runScope.origins.get(origin.id)
		if (runScope.mode === "targeted" && originOps === undefined) {
			coverage.originsSkipped.push(origin.id)
			continue
		}
		const originHooks =
			options.hooks === undefined
				? undefined
				: (() => {
						const { teardownPrincipal: _removed, ...rest } = options.hooks
						return rest
					})()
		const result = await run({
			baseUrl: origin.baseUrl,
			principals: persisted.map(persistedToPrincipal) as [Principal, ...Principal[]],
			spec: origin.spec,
			skipPrincipalTeardown: true,
			...(originHooks === undefined ? {} : { hooks: originHooks }),
			...(options.uploads === undefined ? {} : { uploads: options.uploads }),
			...(options.configDir === undefined ? {} : { configDir: options.configDir }),
			...(options.globalHeaders === undefined ? {} : { globalHeaders: options.globalHeaders }),
			...(options.roots === undefined ? {} : { roots: options.roots }),
			...(options.seed === undefined ? {} : { seed: options.seed }),
			...(options.cohortSize === undefined ? {} : { cohortSize: options.cohortSize }),
			...(originOps === undefined ? {} : { ops: originOps }),
			...(options.profiles === undefined ? {} : { profiles: options.profiles }),
			...(options.profile === undefined ? {} : { profile: options.profile }),
			...(options.rateLimits === undefined ? {} : { rateLimits: options.rateLimits }),
			...(options.keepFixtures === undefined ? {} : { keepFixtures: options.keepFixtures }),
			...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
			...(options.outOfBand === undefined ? {} : { outOfBand: options.outOfBand }),
			...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
			...(options.query === undefined ? {} : { query: options.query }),
			...(options.entities === undefined ? {} : { entities: options.entities }),
			...(options.exchangeDir === undefined ? {} : { exchangeDir: options.exchangeDir }),
			...(options.network === undefined ? {} : { network: options.network }),
		})
		for (const finding of result.findings) {
			findings.report({ ...finding, origin: origin.id })
		}
		for (const check of result.checksRun) checksRun.add(check)
		for (const skip of result.checksSkipped) checksSkipped.push({ ...skip, entity: `${origin.id}:${skip.entity}` })
		for (const suppressed of result.checksSuppressed) {
			checksSuppressed.push({ ...suppressed, entity: `${origin.id}:${suppressed.entity}` })
		}
		for (const entity of result.entitiesTested) entitiesTested.push(`${origin.id}:${entity}`)
		for (const item of result.checksOutOfScope) {
			checksOutOfScope.push({ ...item, entity: `${origin.id}:${item.entity}` })
		}
		for (const op of result.scope.operations) coverage.operations.push({ ...op, origin: origin.id })
		for (const use of result.scope.support) coverage.support.push({ ...use, origin: origin.id })
		for (const item of result.inconclusive) {
			findings.unresolved(item.check, `${origin.id}:${item.entity}`, item.reason)
		}
	}
}
