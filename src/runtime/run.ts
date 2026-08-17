/**
 * Run orchestrator: model → world → checks → findings.
 *
 * The world is seeded once and outlives every check. A seeding failure is recorded once and
 * everything downstream is reported BLOCKED against that single cause, rather than re-failing
 * per case — which is what made prior attempts produce dozens of failures from one broken fixture.
 */

import { buildModel, type EntityModel, type OperationModel, type SpecModel } from "../spec/graph.ts"
import { dereference, loadSpec } from "../spec/load.ts"
import type { Hooks, Principal, ProfileSpec, RateLimitSpec, Uploads } from "../config/define-config.ts"
import { type AcquireSpec, createPrincipal, type PrincipalRuntime } from "./auth.ts"
import { CHECKS, type Actor, type CheckContext } from "./checks.ts"
import { Client, type Exchange } from "./client.ts"
import type { ProgressHandler, ProgressLast, ProgressSnapshot } from "./progress.ts"
import { type Finding, FindingCollector, type Inconclusive } from "./finding.ts"
import { reportFeatureGateSchemaDrift } from "./feature-gate.ts"
import { excludedByProfile, resolveProfile } from "./profile.ts"
import { buildRateLimitRules, RateLimiter } from "./rate-limit.ts"
import { Ledger, type TeardownReport } from "./teardown.ts"
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
	resolveScope,
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
	only?: string[]
	/** Named profiles this run can select between. `"full"` and `"cheap"` exist without an entry. */
	profiles?: Record<string, ProfileSpec>
	/** Active profile by name. Defaults to `"full"` — every operation runs, today's behaviour. */
	profile?: string
	/** Leaves created records in place. Useful when inspecting a failure by hand. */
	keepFixtures?: boolean
	/** Requests allowed in flight at once, across the whole run. */
	maxInFlight?: number
	/** Paces requests per category. Checked before `x-rate-limit` tags for the same request. */
	rateLimits?: RateLimitSpec[]
	/** Live status. Called on phase/entity/check/request; the CLI prints a heartbeat from this. */
	onProgress?: ProgressHandler
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
	/** Checks that ran but could not reach a verdict — see `Inconclusive`. */
	inconclusive: Inconclusive[]
	/** Name of the profile that ran — `"full"` unless `--profile` / `config.profile` said otherwise. */
	profile: string
	/** Operations a profile excluded, and why. Each also has a matching `profile.skip` gap finding. */
	profileExclusions: Array<{ entity: string; operationId: string; reason: string }>
	created: number
	teardown: TeardownReport | null
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

	for (const address of addresses) {
		try {
			await teardown(address)
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
		principalId: principal.id,
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
	const records = await listExisting(listOp, client, headers, scope)
	return { records, scope }
}

/** operationIds named in any principal `auth.steps` — those creates already ran during login. */
function authStepOperationIds(principals: readonly PrincipalSpec[]): Set<string> {
	const ids = new Set<string>()
	for (const principal of principals) {
		for (const step of principal.auth?.steps ?? []) {
			if ("operationId" in step) ids.add(step.operationId)
		}
	}
	return ids
}

function createIsAuthProvisioned(createOp: OperationModel, authCreates: ReadonlySet<string>): boolean {
	return createOp.freshPrincipal || authCreates.has(createOp.operationId)
}

function testableEntities(
	model: SpecModel,
	only: string[] | undefined,
	authCreates: ReadonlySet<string>,
): EntityModel[] {
	return [...model.entities.values()]
		.filter((entity) => {
			if (only !== undefined && only.length > 0 && !only.includes(entity.name)) return false
			const createOp = entity.create === undefined ? undefined : model.byOperationId.get(entity.create)
			const authProvisioned = createOp !== undefined && createIsAuthProvisioned(createOp, authCreates)
			/* Register-as-create with no item route is the auth flow, not a fixture. */
			if (authProvisioned && entity.read === undefined) return false
			if (entity.invite !== null && entity.list !== undefined) return true
			return entity.list !== undefined && entity.create !== undefined && entity.trackable
		})
		.sort((a, b) => a.name.localeCompare(b.name))
}

export async function run(options: RunOptions): Promise<RunResult> {
	const startedAt = Date.now()
	const findings = new FindingCollector()
	const profile = resolveProfile(options.profile, options.profiles)
	const profileExclusions: Array<{ entity: string; operationId: string; reason: string }> = []
	let last: ProgressLast | undefined
	let currentPhase: ProgressSnapshot["phase"] = "load"
	let currentEntity: string | undefined
	let currentCheck: string | undefined
	let currentEntityIndex: number | undefined
	let entityTotal: number | undefined
	const defectCount = (): number =>
		findings.findings.filter((f) => f.verdict !== "BLOCKED" && f.verdict !== "COVERAGE_GAP").length
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
		const snap: ProgressSnapshot = {
			elapsedMs: Date.now() - startedAt,
			findings: defectCount(),
			phase: partial.phase,
			requests: partial.requests ?? 0,
		}
		if (partial.entity !== undefined) snap.entity = partial.entity
		if (partial.entityIndex !== undefined) snap.entityIndex = partial.entityIndex
		if (partial.entityTotal !== undefined) snap.entityTotal = partial.entityTotal
		if (partial.check !== undefined) snap.check = partial.check
		if (partial.message !== undefined) snap.message = partial.message
		if (last !== undefined) snap.last = last
		publish(snap)
	}

	tick({ message: options.spec, phase: "load", requests: 0 })
	const raw = await loadSpec(options.spec, options.baseUrl)
	const { doc } = dereference(raw)
	const model = buildModel(doc)
	try {
		probeCreateFixtures(model)
	} catch (error) {
		if (!isOverflowError(error)) throw error
	}
	const authCreates = authStepOperationIds(options.principals)
	const rateLimiter = new RateLimiter(buildRateLimitRules(model, options.rateLimits))
	const client = new Client(
		options.baseUrl,
		options.globalHeaders ?? {},
		options.maxInFlight ?? 4,
		(exchange: Exchange) => {
			last = {
				at: exchange.at,
				durationMs: exchange.durationMs,
				method: exchange.method,
				requestBytes: exchange.requestBytes,
				requestId: exchange.requestId,
				responseBytes: exchange.responseBytes,
				status: exchange.status,
				url: exchange.url,
			}
			const snap: ProgressSnapshot = {
				elapsedMs: Date.now() - startedAt,
				findings: defectCount(),
				last,
				phase: currentPhase,
				requests: client.transcript.length,
			}
			if (currentCheck !== undefined) snap.check = currentCheck
			if (currentEntity !== undefined) snap.entity = currentEntity
			if (currentEntityIndex !== undefined) snap.entityIndex = currentEntityIndex
			if (entityTotal !== undefined) snap.entityTotal = entityTotal
			publish(snap)
		},
		rateLimiter,
	)
	const validator = new SchemaValidator()
	const ledger = new Ledger()
	const seed = options.seed ?? 1

	if (options.principals[0] === undefined) throw new Error("oat: at least one principal is required")

	const hooks = options.hooks ?? {}
	const uploads: UploadContext = {
		seed,
		...(options.uploads === undefined ? {} : { uploads: options.uploads }),
		...(options.configDir === undefined ? {} : { configDir: options.configDir }),
		...(hooks.resolveUpload === undefined ? {} : { resolveUpload: hooks.resolveUpload }),
	}
	const worldUploads = (seedOffset = 0): UploadContext =>
		seedOffset === 0 ? uploads : { ...uploads, seed: seed + seedOffset }
	const resolved: ResolvedPrincipal[] = []
	for (const principal of options.principals) {
		resolved.push(await resolvePrincipal(principal, model, client, hooks))
	}
	tick({
		message: `${resolved.length} principal(s)`,
		phase: "auth",
		requests: client.transcript.length,
	})
	const alpha = resolved[0] as ResolvedPrincipal
	/* Isolation peer: first principal whose roots are a different tenant — not "whoever is
	 * second in the array". A same-tenant viewer sitting at index 1 must not steal that slot. */
	const peer = resolved.slice(1).find((candidate) => !sameTenant(alpha.roots, candidate.roots))

	const entitiesTested: string[] = []
	const checksRun = new Set<string>()
	const checksSkipped: Array<{ check: string; entity: string; needs: string }> = []
	const checksSuppressed: Array<{ check: string; entity: string; because: string }> = []

	const excludedIds = new Set<string>()
	const excludeOp = (entity: EntityModel, op: OperationModel | undefined): boolean => {
		if (op === undefined) return false
		const reason = excludedByProfile(op, profile.spec)
		if (reason === null) return false
		if (excludedIds.has(op.operationId)) return true
		excludedIds.add(op.operationId)
		profileExclusions.push({ entity: entity.name, operationId: op.operationId, reason })
		findings.gap(
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
		if (createOp !== undefined && excludeOp(entity, createOp)) {
			/* Same fallback a failed create takes below: read-only coverage against whatever
			 * already exists beats no coverage, and it is exactly the state most likely to hide a
			 * read-path bug. The gap finding excludeOp already reported names the reason. */
			const existing = await readExisting(listOp, client, alpha.headers(), {
				...options.roots,
				...alpha.roots,
			})
			if (existing.records.length === 0) {
				findings.blocked(
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
			const existing = await readExisting(listOp, client, alpha.headers(), {
				...options.roots,
				...alpha.roots,
			})
			scope = { created: [], values: { ...rootValues, ...existing.scope } }
			records = existing.records
			degraded = true
		} else {
			try {
				scope = await resolveScope(createOp, model, client, {
					authHeaders: alpha.headers,
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
					client,
					{
						authHeaders: alpha.headers,
						...(options.cohortSize === undefined ? {} : { cohortSize: options.cohortSize }),
						roots: rootValues,
						seed,
						uploads,
					},
					scope,
				)
				if (cohort.adopted === true) {
					/* Plan limit after an effect already created the row: keep the id so children
					 * (row after extract→table) can seed, but do not assert write-path oracles
					 * against a body oat never submitted. */
					findings.gap(
						"world.seed",
						entity.name,
						`seeding "${entity.name}" hit a plan limit; using an existing same-tenant record`,
						`${createOp.operationId} returned a plan-limit refusal and the list already ` +
							"had a record — likely an earlier x-effects create. Write-path checks stand " +
							"down rather than treat payment_required as a backend defect.",
					)
					records = cohort.records
					degraded = true
					for (const ancestor of scope.created) {
						ledger.record(ancestor.entity, ancestor.id, scope.values)
					}
					for (const record of records) {
						const id = record[entity.identity ?? "id"]
						if (typeof id === "string" || typeof id === "number") {
							ledger.record(entity.name, String(id), scope.values)
						}
					}
				} else if (cohort.featureGate !== null) {
					/* Same degradation a profile-excluded create takes: the tag said this
					 * principal cannot create the row, so a correct 403 is coverage, not a
					 * seed defect. The 403 body still has to match the documented schema. */
					reportFeatureGateSchemaDrift(
						findings,
						validator,
						createOp,
						model.rawOperations.get(createOp.operationId),
						cohort.featureGate.exchange,
						entity.name,
					)
					findings.gap(
						"world.seed",
						entity.name,
						`seeding "${entity.name}" is gated by ${cohort.featureGate.detail}`,
						`${cohort.featureGate.detail}. Checks that need a row oat created stand down ` +
							"rather than treat the documented 403 as a defect.",
					)
					const existing = await readExisting(listOp, client, alpha.headers(), {
						...options.roots,
						...alpha.roots,
					})
					if (existing.records.length === 0) {
						findings.blocked(
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
					records = cohort.records
					/* Ancestors first, then the cohort — the unwind reverses this, so children are
					 * always removed before the parents they hang from. */
					for (const ancestor of scope.created) {
						ledger.record(ancestor.entity, ancestor.id, scope.values)
					}
					for (const record of records) {
						ledger.record(entity.name, String(record[entity.identity ?? "id"]), scope.values)
					}
				}
			} catch (error) {
				if (isOverflowError(error)) {
					const overflow = overflowFrom(error, createOp.operationId)
					findings.gap("world.seed", entity.name, overflow.message, overflow.message)
					const existing = await readExisting(listOp, client, alpha.headers(), {
						...options.roots,
						...alpha.roots,
					})
					if (existing.records.length === 0) {
						findings.blocked("world.seed", entity.name, `could not seed "${entity.name}"`, overflow.message)
						return
					}
					scope = { created: [], values: existing.scope }
					records = existing.records
					degraded = true
				} else {
					const cause = error instanceof SeedError ? error.cause_ : "unknown"
					const status = error instanceof SeedError ? error.status : undefined
					const message = error instanceof Error ? error.message : String(error)

					/* A create that fails with 5xx is not a fixture problem — it is the defect.
					 * Reporting it as merely "blocked" buries the most serious thing oat found. */
					if (status !== undefined && status >= 500) {
						findings.backend(
							"create.does-not-error",
							entity.name,
							`creating a "${entity.name}" fails with a server error`,
							`${message}. The request body was generated from the documented schema, so ` +
								"either the handler rejects input the document permits, or it is failing " +
								"outright. Everything downstream of this entity is untestable until it is " +
								"fixed.",
							client.transcript.filter((e) => e.status >= 500).slice(-1),
						)
					}

					/* Fall back to whatever already exists. A backend whose create is broken can still
					 * have a working list, and read-only coverage beats no coverage — this is exactly
					 * the state in which a read-path bug is most likely to be sitting undiscovered. */
					const existing = await readExisting(listOp, client, alpha.headers(), {
						...options.roots,
						...alpha.roots,
					})
					if (existing.records.length === 0) {
						findings.blocked("world.seed", entity.name, `could not seed "${entity.name}"`, `${cause}: ${message}`)
						return
					}

					findings.gap(
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
				const next = await resolveScope(listOp, model, client, {
					authHeaders: principal.headers,
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
		const trackingClient =
			createOp === undefined || degraded
				? client
				: new Proxy(client, {
						get(target, property, receiver) {
							if (property !== "request") return Reflect.get(target, property, receiver)
							return async (
								method: string,
								path: string,
								options?: Parameters<Client["request"]>[2],
							): Promise<Exchange> => {
								const exchange = await target.request(method, path, options ?? {})
								if (method.toUpperCase() !== "POST" || exchange.status >= 300) return exchange
								const body = exchange.responseBody
								if (body === null || typeof body !== "object") return exchange
								const id = (body as Record<string, unknown>)[entity.identity ?? "id"]
								if (typeof id !== "string" && typeof id !== "number") return exchange
								/* Recording the same id twice is harmless — the unwind tolerates a 404
								 * on an already-removed record — and missing one is not. */
								ledger.record(entity.name, String(id), scope.values)
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

		const ctx: CheckContext = {
			actors,
			altAuth,
			altScope,
			asyncOps: model.operations.filter((op) => op.entity === entity.name && op.async !== null && invocable(op)),
			effectOps: model.operations.filter((op) => op.entity === entity.name && op.effects.length > 0 && invocable(op)),
			auth: alpha.headers,
			...(alpha.runtime === undefined ? {} : { refreshIfStale: alpha.runtime.refreshIfStale }),
			client: trackingClient,
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
			listOp,
			model,
			query: listOp.query,
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
			updateOp: degraded || updateExcluded ? undefined : updateOpModel,
			uploads,
			validator,
		}

		entitiesTested.push(entity.name)

		const runOne = async (check: (typeof CHECKS)[number]): Promise<void> => {
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
				await check.run(ctx)
			} catch (error) {
				findings.gap(
					check.id,
					entity.name,
					`check "${check.id}" could not complete`,
					error instanceof Error ? error.message : String(error),
				)
			}
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
			if (!check.applicable(ctx)) {
				/* Recorded, not dropped: on an API shaped unlike the fixture this is most of the
				 * suite, and a silent skip reads exactly like a clean result. */
				checksSkipped.push({
					check: check.id,
					entity: entity.name,
					needs: check.needs ?? "an unstated precondition",
				})
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
	const queue = testableEntities(model, options.only, authCreates)
	entityTotal = queue.length
	for (const [index, entity] of queue.entries()) {
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
			: await ledger.unwind(model, client, alpha.headers, (done, total, item) => {
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

	await teardownPrincipals(resolved, hooks, findings)
	reportRateLimitViolations(client, findings)

	tick({
		message: "done",
		phase: "done",
		requests: client.transcript.length,
	})

	return {
		checksRun: [...checksRun].sort(),
		checksSkipped,
		checksSuppressed,
		inconclusive: findings.inconclusive,
		client,
		created: ledger.size,
		entitiesTested,
		findings: findings.findings,
		model,
		profile: profile.name,
		profileExclusions,
		teardown,
	}
}
