/**
 * Operation scope: which operations a run grades.
 *
 * A full run grades every operation some check judges. A targeted run (`--ops`, `--only`) grades
 * only the named operations. Everything else oat calls — principal sign-up, parent creates, the
 * cohort create behind a list, teardown deletes — is support: called to reach or observe a
 * target, never graded. Resolution is static over the entity graph so `oat plan --ops` can show
 * the scope with no network, and so a typo fails before the first request.
 */

import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import type { Finding, Inconclusive } from "../finding.ts"
import type { GradeLedger, PassEvidence } from "../grades.ts"

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

export type OperationStatus = "passed" | "failed" | "inconclusive" | "blocked" | "untested"

export type PassTier = "contract" | "verified"

/**
 * `verified`: a later exchange shows what the call did. `complete`: a read, or an operation that
 * declares it has no effects, met its contract, which is all it promises. `unproven`: the call met
 * its contract, but whatever it changes was never observed.
 */
export type Sufficiency = "verified" | "complete" | "unproven"

export interface OperationCoverage {
	operationId: string
	/** Secondary origin id; absent on the primary. */
	origin?: string
	entity: string | null
	status: OperationStatus
	/** `gaps`: ran, but reported it could not exercise this operation (a missing peer, tag, or route). */
	checks: { passed: string[]; failed: string[]; suppressed: string[]; inconclusive: string[]; gaps: string[] }
	/** Defect findings attributed to this operation. */
	findings: number
	/** Why it was not graded, when it was not. */
	reason: string | null
	/**
	 * How a pass was proven. `verified`: a later exchange shows a value from the call.
	 * `contract`: the call got a documented success and its body matched the schema.
	 */
	tier?: PassTier
	/** The exchanges behind a pass. */
	evidence?: PassEvidence
	/** How far a pass goes; see `sufficiencyOf`. */
	sufficiency?: Sufficiency
	/** One line on why the pass goes that far, or why the operation did not pass. */
	why?: string
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
