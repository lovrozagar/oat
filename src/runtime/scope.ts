/**
 * Operation scope: which operations a run grades.
 *
 * A full run grades every operation some check judges. A targeted run (`--ops`, `--only`) grades
 * only the named operations. Everything else oat calls — principal sign-up, parent creates, the
 * cohort create behind a list, teardown deletes — is support: called to reach or observe a
 * target, never graded. Resolution is static over the entity graph so `oat plan --ops` can show
 * the scope with no network, and so a typo fails before the first request.
 */

import { isAuthFlow, type Principal } from "../config/define-config.ts"
import { type OperationModel, type EntityModel, owningEntityName, type SpecModel } from "../spec/graph.ts"
import { pathTemplateMatches } from "../spec/load.ts"
import { CHECKS } from "./checks.ts"
import type { Exchange } from "./client.ts"
import type { Finding, Inconclusive } from "./finding.ts"

export class ScopeError extends Error {
	override name = "ScopeError"
}

export interface ScopeInput {
	/** operationIds; `*` globs within one id; `<originId>:<operationId>` routes to an origin. */
	ops?: readonly string[]
	/** Entity names; each expands to every operation the entity owns. */
	only?: readonly string[]
	/** Secondary origins by id, so prefixed targets validate before any request. */
	origins?: ReadonlyMap<string, SpecModel>
	/** Creates that already ran as principal auth steps — those entities are not fixtures. */
	authCreates?: ReadonlySet<string>
	/** Active profile gate. An exact target it excludes is a usage error, not a quiet gap. */
	exclusion?: { profile: string; reason: (op: OperationModel) => string | null }
}

export interface TargetScope {
	mode: "full" | "targeted"
	requested: { ops: string[]; only: string[] }
	/** Primary-origin targets. Empty in a full run, where `inScope` is always true. */
	targets: ReadonlySet<string>
	/** Origin id → its targets, prefix removed. Only origins with at least one target appear. */
	origins: ReadonlyMap<string, string[]>
	/** Entities seeded and checked, in run order. */
	entities: EntityModel[]
	/** Target → why no check can ever grade it. */
	untestable: ReadonlyMap<string, string>
	/** Glob or `--only` matches the profile excluded, dropped from the targets. */
	excluded: Array<{ operationId: string; reason: string }>
	inScope: (operationId: string) => boolean
}

/** Union of every check's subjects for this entity. */
export function staticSubjects(entity: EntityModel, model: SpecModel): Set<string> {
	const ids = new Set<string>()
	for (const check of CHECKS) for (const id of check.subjects(entity, model)) ids.add(id)
	return ids
}

/** operationIds named in any principal `auth.steps` — those creates already ran during login. */
export function authStepOperationIds(principals: readonly Principal[]): Set<string> {
	const ids = new Set<string>()
	for (const principal of principals) {
		const auth = principal.auth
		if (auth === undefined || !isAuthFlow(auth)) continue
		for (const step of auth.steps) {
			if ("operationId" in step) ids.add(step.operationId)
		}
	}
	return ids
}

export function createIsAuthProvisioned(createOp: OperationModel, authCreates: ReadonlySet<string>): boolean {
	return createOp.freshPrincipal || authCreates.has(createOp.operationId)
}

/** Why an entity cannot be seeded and checked, or `null` when it can. */
export function untestableEntityReason(
	entity: EntityModel,
	model: SpecModel,
	authCreates: ReadonlySet<string>,
): string | null {
	const createOp = entity.create === undefined ? undefined : model.byOperationId.get(entity.create)
	const authProvisioned = createOp !== undefined && createIsAuthProvisioned(createOp, authCreates)
	/* Register-as-create with no item route is the auth flow, not a fixture. */
	if (authProvisioned && entity.read === undefined) {
		return `"${entity.name}" is created by the auth flow and has no item route`
	}
	if (entity.invite !== null && entity.list !== undefined) return null
	/* An action that declares x-effects can run against rows the list already returns.
	 * The action's x-before creates the row the list does not have yet. */
	if (
		entity.list !== undefined &&
		entity.actions.some((id) => {
			const action = model.byOperationId.get(id)
			return action !== undefined && action.effects.length > 0
		})
	) {
		return null
	}
	const missing = [
		...(entity.list === undefined ? ["a list operation"] : []),
		...(entity.create === undefined ? ["a create operation"] : []),
		...(entity.list !== undefined && entity.create !== undefined && !entity.trackable
			? ["records oat can identify after create"]
			: []),
	]
	return missing.length === 0 ? null : `"${entity.name}" has no ${missing.join(" and no ")}`
}

export function testableEntities(model: SpecModel, authCreates: ReadonlySet<string>): EntityModel[] {
	return [...model.entities.values()]
		.filter((entity) => untestableEntityReason(entity, model, authCreates) === null)
		.sort((a, b) => a.name.localeCompare(b.name))
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
	return new RegExp(`^${escaped}$`)
}

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i)
	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0] as number
		row[0] = i
		for (let j = 1; j <= b.length; j++) {
			const above = row[j] as number
			row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
			diagonal = above
		}
	}
	return row[b.length] as number
}

function nearest(name: string, candidates: Iterable<string>): string[] {
	return [...candidates]
		.map((candidate) => ({ candidate, d: distance(name, candidate) }))
		.filter((item) => item.d <= Math.max(3, Math.floor(name.length / 3)))
		.sort((a, b) => a.d - b.d || a.candidate.localeCompare(b.candidate))
		.slice(0, 3)
		.map((item) => item.candidate)
}

function didYouMean(name: string, candidates: Iterable<string>): string {
	const close = nearest(name, candidates)
	return close.length === 0 ? "" : ` Did you mean: ${close.join(", ")}?`
}

interface Matched {
	ids: string[]
	exact: boolean
}

function matchPattern(pattern: string, model: SpecModel, label: string): Matched {
	if (!pattern.includes("*")) {
		if (model.byOperationId.has(pattern)) return { exact: true, ids: [pattern] }
		throw new ScopeError(
			`oat: --ops "${label}" matches no operation.${didYouMean(pattern, model.byOperationId.keys())}`,
		)
	}
	const re = globToRegExp(pattern)
	const ids = [...model.byOperationId.keys()].filter((id) => re.test(id))
	if (ids.length === 0) throw new ScopeError(`oat: --ops "${label}" matches no operation.`)
	return { exact: false, ids }
}

function untestableReason(op: OperationModel, model: SpecModel, authCreates: ReadonlySet<string>): string {
	if (op.entity === null) {
		return `unmodeled: no entity owns ${op.method.toUpperCase()} ${op.path}`
	}
	const entity = model.entities.get(op.entity)
	const why =
		entity === undefined ? `"${op.entity}" is not modeled` : untestableEntityReason(entity, model, authCreates)
	if (why !== null) return `entity-not-testable: ${why}`
	return `no-applicable-check: no check judges ${op.operationId}`
}

export function resolveTargetScope(model: SpecModel, input: ScopeInput): TargetScope {
	const ops = [...(input.ops ?? [])].map((s) => s.trim()).filter(Boolean)
	const only = [...(input.only ?? [])].map((s) => s.trim()).filter(Boolean)
	const authCreates = input.authCreates ?? new Set<string>()
	const testable = testableEntities(model, authCreates)
	const requested = { only, ops }

	if (ops.length === 0 && only.length === 0) {
		return {
			entities: testable,
			excluded: [],
			inScope: () => true,
			mode: "full",
			origins: new Map(),
			requested,
			targets: new Set(),
			untestable: new Map(),
		}
	}

	const targets = new Set<string>()
	const originTargets = new Map<string, Set<string>>()
	const excluded: Array<{ operationId: string; reason: string }> = []

	const admit = (id: string, exact: boolean, opModel: SpecModel, into: Set<string>, label: string): void => {
		const op = opModel.byOperationId.get(id)
		const reason = op === undefined || input.exclusion === undefined ? null : input.exclusion.reason(op)
		if (reason === null) {
			into.add(id)
			return
		}
		if (exact) {
			throw new ScopeError(
				`oat: target ${label} is excluded by --profile ${input.exclusion?.profile} (${reason}). ` +
					`Drop it from --ops or run --profile full.`,
			)
		}
		excluded.push({ operationId: label, reason })
	}

	for (const pattern of ops) {
		const colon = pattern.indexOf(":")
		const originId = colon > 0 ? pattern.slice(0, colon) : undefined
		const originModel = originId === undefined ? undefined : input.origins?.get(originId)
		if (originId !== undefined && originModel !== undefined) {
			const local = pattern.slice(colon + 1)
			const into = originTargets.get(originId) ?? new Set<string>()
			originTargets.set(originId, into)
			const matched = matchPattern(local, originModel, pattern)
			for (const id of matched.ids) admit(id, matched.exact, originModel, into, `${originId}:${id}`)
			continue
		}
		if (originId !== undefined && !model.byOperationId.has(pattern) && input.origins !== undefined) {
			const known = [...input.origins.keys()]
			if (!known.includes(originId)) {
				throw new ScopeError(
					`oat: --ops "${pattern}" names origin "${originId}", which is not configured.` +
						(known.length === 0 ? "" : ` Known: ${known.join(", ")}.`),
				)
			}
		}
		const matched = matchPattern(pattern, model, pattern)
		for (const id of matched.ids) admit(id, matched.exact, model, targets, id)
	}

	for (const name of only) {
		let found = false
		if (model.entities.has(name)) {
			found = true
			for (const op of model.operations)
				if (op.entity === name) admit(op.operationId, false, model, targets, op.operationId)
		}
		for (const [originId, originModel] of input.origins ?? []) {
			if (!originModel.entities.has(name)) continue
			found = true
			const into = originTargets.get(originId) ?? new Set<string>()
			originTargets.set(originId, into)
			for (const op of originModel.operations) {
				if (op.entity === name) admit(op.operationId, false, originModel, into, `${originId}:${op.operationId}`)
			}
		}
		if (!found) {
			const known = [
				...model.entities.keys(),
				...[...(input.origins?.values() ?? [])].flatMap((m) => [...m.entities.keys()]),
			]
			throw new ScopeError(`oat: --only "${name}" names no entity.${didYouMean(name, known)}`)
		}
	}

	const graded = new Set<string>()
	const entities = testable.filter((entity) => {
		const subjects = staticSubjects(entity, model)
		const hit = [...subjects].some((id) => targets.has(id))
		if (hit) for (const id of subjects) if (targets.has(id)) graded.add(id)
		return hit
	})

	const untestable = new Map<string, string>()
	for (const id of targets) {
		if (graded.has(id)) continue
		const op = model.byOperationId.get(id)
		if (op !== undefined) untestable.set(id, untestableReason(op, model, authCreates))
	}

	const origins = new Map<string, string[]>()
	for (const [originId, ids] of originTargets) if (ids.size > 0) origins.set(originId, [...ids])

	return {
		entities,
		excluded,
		inScope: (operationId) => targets.has(operationId),
		mode: "targeted",
		origins,
		requested,
		targets,
		untestable,
	}
}

/* ------------------------------------------------------------------ coverage */

export type OperationStatus = "held" | "failed" | "inconclusive" | "blocked" | "untested"

export interface OperationCoverage {
	operationId: string
	/** Secondary origin id; absent on the primary. */
	origin?: string
	entity: string | null
	status: OperationStatus
	/** `gaps`: ran, but reported it could not exercise this operation (a missing peer, tag, or route). */
	checks: { held: string[]; failed: string[]; suppressed: string[]; inconclusive: string[]; gaps: string[] }
	/** Defect findings attributed to this operation. */
	findings: number
	/** Why it was not graded, when it was not. */
	reason: string | null
}

/** An operation a targeted run called without grading it. */
export interface SupportUse {
	operationId: string
	origin?: string
	calls: number
	non2xx: number
	firstFailure?: { status: number; requestId: string }
}

export interface ScopeReport {
	mode: "full" | "targeted"
	requested: { ops: string[]; only: string[] }
	operations: OperationCoverage[]
	support: SupportUse[]
	/** Glob or `--only` matches the profile excluded. */
	excluded: Array<{ operationId: string; reason: string }>
	/** Secondary origins a targeted run did not touch because none of their operations were targets. */
	originsSkipped: string[]
}

/** Which checks graded which operations, filled as checks run. */
export class GradeLedger {
	readonly ran = new Map<string, Set<string>>()
	readonly suppressed = new Map<string, Set<string>>()
	readonly needs = new Map<string, Set<string>>()

	#add(map: Map<string, Set<string>>, operations: readonly string[], value: string): void {
		for (const op of operations) {
			const set = map.get(op) ?? new Set<string>()
			set.add(value)
			map.set(op, set)
		}
	}

	graded(operations: readonly string[], check: string): void {
		this.#add(this.ran, operations, check)
	}

	suppress(operations: readonly string[], check: string): void {
		this.#add(this.suppressed, operations, check)
	}

	skipped(operations: readonly string[], needs: string): void {
		this.#add(this.needs, operations, needs)
	}
}

const NOT_DEFECTS = new Set(["COVERAGE_GAP", "BLOCKED"])

/** The operation an exchange hit, preferring literal segments over parameters on a tie. */
export function operationFor(model: SpecModel, method: string, url: string, baseUrl: string): OperationModel | null {
	let pathname: string
	let basePath: string
	try {
		pathname = new URL(url).pathname
		basePath = new URL(baseUrl).pathname.replace(/\/$/, "")
	} catch {
		return null
	}
	const local = basePath !== "" && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
	let best: OperationModel | null = null
	let bestParams = Number.POSITIVE_INFINITY
	for (const op of model.operations) {
		if (op.method.toUpperCase() !== method.toUpperCase()) continue
		if (!pathTemplateMatches(op.path, local) && !pathTemplateMatches(op.path, pathname)) continue
		if (op.pathParams.length < bestParams) {
			best = op
			bestParams = op.pathParams.length
		}
	}
	return best
}

export interface CoverageInput {
	model: SpecModel
	scope: TargetScope
	ledger: GradeLedger
	findings: readonly Finding[]
	inconclusive: readonly Inconclusive[]
	transcript: readonly Exchange[]
	baseUrl: string
	authCreates: ReadonlySet<string>
}

function statusOf(held: number, failed: number, inconclusive: number, blocked: boolean): OperationStatus {
	if (failed > 0) return "failed"
	if (held > 0) return "held"
	if (inconclusive > 0) return "inconclusive"
	return blocked ? "blocked" : "untested"
}

export function buildScopeReport(input: CoverageInput): ScopeReport {
	const { model, scope, ledger } = input
	const graded = new Set<string>()
	for (const entity of scope.entities) for (const id of staticSubjects(entity, model)) graded.add(id)

	const ids = scope.mode === "targeted" ? [...scope.targets].sort() : model.operations.map((op) => op.operationId)

	const operations = ids.map((operationId): OperationCoverage => {
		const op = model.byOperationId.get(operationId)
		const mine = (attributed: string[] | undefined): boolean => attributed?.includes(operationId) === true
		const defects = input.findings.filter((f) => mine(f.operations) && !NOT_DEFECTS.has(f.verdict))
		const blocked = input.findings.filter((f) => mine(f.operations) && f.verdict === "BLOCKED")
		const failed = [...new Set(defects.map((f) => f.check))].sort()
		const inconclusive = [...new Set(input.inconclusive.filter((i) => mine(i.operations)).map((i) => i.check))]
			.filter((check) => !failed.includes(check))
			.sort()
		const ran = ledger.ran.get(operationId) ?? new Set<string>()
		const gapFindings = input.findings.filter(
			(f) => mine(f.operations) && f.verdict === "COVERAGE_GAP" && ran.has(f.check),
		)
		const gaps = [...new Set(gapFindings.map((f) => f.check))].filter((check) => !failed.includes(check)).sort()
		const held = [...ran]
			.filter((check) => !failed.includes(check) && !inconclusive.includes(check) && !gaps.includes(check))
			.sort()
		const suppressed = [...(ledger.suppressed.get(operationId) ?? [])].sort()
		const status = statusOf(
			held.length,
			failed.length,
			inconclusive.length,
			suppressed.length > 0 || blocked.length > 0,
		)
		let reason: string | null = null
		if (status === "blocked") {
			reason = blocked[0]?.detail ?? `suppressed by an earlier failure (${suppressed.join(", ")})`
		} else if (status === "untested") {
			const statically =
				scope.untestable.get(operationId) ??
				(op !== undefined && !graded.has(operationId) ? untestableReason(op, model, input.authCreates) : undefined)
			const needs = [...(ledger.needs.get(operationId) ?? [])]
			reason =
				statically ??
				(gapFindings[0] === undefined ? undefined : `coverage gap: ${gapFindings[0].summary}`) ??
				(needs.length > 0 ? `no check applied: needs ${needs.slice(0, 3).join("; ")}` : "no check exercised it")
		}
		return {
			checks: { failed, gaps, held, inconclusive, suppressed },
			entity: op?.entity ?? null,
			findings: defects.length,
			operationId,
			reason,
			status,
		}
	})

	const support = new Map<string, SupportUse>()
	if (scope.mode === "targeted") {
		for (const exchange of input.transcript) {
			const named = exchange.operationId === undefined ? undefined : model.byOperationId.get(exchange.operationId)
			const op = named ?? operationFor(model, exchange.method, exchange.url, input.baseUrl)
			if (op === null || scope.targets.has(op.operationId)) continue
			const use = support.get(op.operationId) ?? { calls: 0, non2xx: 0, operationId: op.operationId }
			use.calls++
			if (exchange.status < 200 || exchange.status >= 300) {
				use.non2xx++
				use.firstFailure ??= { requestId: exchange.requestId, status: exchange.status }
			}
			support.set(op.operationId, use)
		}
	}

	return {
		excluded: scope.excluded,
		mode: scope.mode,
		operations,
		originsSkipped: [],
		requested: scope.requested,
		support: [...support.values()].sort((a, b) => a.operationId.localeCompare(b.operationId)),
	}
}

/** `--ops a,b --only c` as the reader typed it. */
export function describeRequested(requested: { ops: readonly string[]; only: readonly string[] }): string {
	return [
		...(requested.ops.length > 0 ? [`--ops ${requested.ops.join(",")}`] : []),
		...(requested.only.length > 0 ? [`--only ${requested.only.join(",")}`] : []),
	].join(" ")
}

/* ---------------------------------------------------------------------- plan */

export interface ScopePlan {
	mode: "full" | "targeted"
	requested: { ops: string[]; only: string[] }
	entities: string[]
	targets: Array<{ operationId: string; entity: string | null; checks: string[] }>
	untestable: Array<{ operationId: string; reason: string }>
	/** Predicted from the graph: lifecycle routes of queued entities and the parents their creates need. */
	support: string[]
	excluded: Array<{ operationId: string; reason: string }>
	origins: Record<string, string[]>
}

/** The scope a run would take, with no network: what `oat plan --ops` prints. */
export function planScope(model: SpecModel, scope: TargetScope): ScopePlan {
	const checksFor = new Map<string, Set<string>>()
	for (const entity of scope.entities) {
		for (const check of CHECKS) {
			for (const id of check.subjects(entity, model)) {
				if (!scope.inScope(id)) continue
				const set = checksFor.get(id) ?? new Set<string>()
				set.add(check.id)
				checksFor.set(id, set)
			}
		}
	}

	const support = new Set<string>()
	const parents = (op: OperationModel | undefined, seen: Set<string>): void => {
		if (op === undefined || seen.has(op.operationId)) return
		seen.add(op.operationId)
		for (const param of op.pathParams) {
			const owner = owningEntityName(op.path, param)
			const create = owner === null ? undefined : model.byOperationId.get(model.entities.get(owner)?.create ?? "")
			if (create === undefined || create.operationId === op.operationId) continue
			support.add(create.operationId)
			parents(create, seen)
		}
	}
	for (const entity of scope.entities) {
		for (const id of [entity.create, entity.list, entity.read, entity.delete]) if (id !== undefined) support.add(id)
		parents(model.byOperationId.get(entity.create ?? ""), new Set())
	}

	const ids = scope.mode === "targeted" ? [...scope.targets].sort() : [...checksFor.keys()].sort()
	return {
		entities: scope.entities.map((entity) => entity.name),
		excluded: scope.excluded,
		mode: scope.mode,
		origins: Object.fromEntries(scope.origins),
		requested: scope.requested,
		support: [...support].filter((id) => scope.mode === "full" || !scope.targets.has(id)).sort(),
		targets: ids
			.filter((id) => !scope.untestable.has(id))
			.map((operationId) => ({
				checks: [...(checksFor.get(operationId) ?? [])].sort(),
				entity: model.byOperationId.get(operationId)?.entity ?? null,
				operationId,
			})),
		untestable: [...scope.untestable].map(([operationId, reason]) => ({ operationId, reason })),
	}
}
