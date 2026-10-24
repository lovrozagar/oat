import { MissingValueError } from "../../../errors/missing-value.ts"
import type { WriteContext } from "../../checks/core/context.ts"
import type { Check } from "../../checks/core/check.ts"
import { entityChecks } from "../../checks/core/registry.ts"
import { checkSalts, runOn } from "../../checks/core/run.ts"
import { CHECKS } from "../../checks/registry.ts"
import type { Client } from "../../../client/client.ts"
import { UnsatisfiedSecurity } from "../../../client/credential-source.ts"
import { FencedError } from "../../fence.ts"
import { guardedClient, HeldRecordError, ProtectedWriteError } from "../../own-record.ts"
import { ownRecordsOf } from "../own-records.ts"
import { type FindingCollector, isRootCause, type Outcome, standDown } from "../../finding.ts"
import { isNetworkError } from "../../../errors/network.ts"
import type { RunContext } from "../context.ts"
import type { EntityRun } from "./state.ts"
import { messageOf } from "../../../errors/message.ts"
import type { RunFindingId } from "../../check-ids.ts"

export type { Check }

/** One entity's check run: what each check grades, what its plan gathered, how each ended. */
export interface CheckLoop {
	run: EntityRun
	context: WriteContext
	plans: Map<string, unknown>
	outcomes: Map<string, Outcome>
}

/** A check whose plan applies, with the subjects it grades: in scope, and not excluded by the profile. */
export interface PlannedCheck {
	check: Check
	graded: string[]
}

/** One check under way: the check, the view its findings are attributed through, and where they begin. */
interface Running {
	check: Check
	attributed: FindingCollector
	/** How many findings the run held when the check began. */
	start: number
}

/** How a check ended, and the subjects it grades and those it judged. */
interface Ended {
	outcome: Outcome
	graded: string[]
	judged: string[]
}

/** Runs one check, records how it ended, and grades its subjects by that. */
export async function runCheck(loop: CheckLoop, { check, graded }: PlannedCheck): Promise<void> {
	const { run } = loop
	const { ctx, entity } = run
	const attributed = graded.length === 0 ? ctx.findings : ctx.findings.attributed(graded)
	const running: Running = { attributed, check, start: ctx.findings.findings.length }
	let judged: Set<string> | undefined
	const view = viewFor(loop, running, (operationIds) => {
		judged ??= new Set()
		for (const id of operationIds) judged.add(id)
	})
	ctx.state.checksRun.add(check.id)
	ctx.progress.tick({
		check: check.id,
		entity: entity.name,
		entityIndex: ctx.progress.entityIndex,
		entityTotal: ctx.progress.entityTotal,
		phase: "test",
		requests: ctx.progress.requests,
	})
	const began = performance.now()
	const ran = await outcomeOf(loop, running, view)
	if (ran === undefined) return
	ctx.state.checkTimings.push({ check: check.id, entity: entity.name, ms: Math.round(performance.now() - began) })
	const outcome = reported(run, running, ran)
	loop.outcomes.set(check.id, outcome)
	judge(run, check, {
		graded,
		judged: judged === undefined ? graded : graded.filter((id) => judged?.has(id) === true),
		outcome,
	})
}

/**
 * The check's own view of the context. Its own client: every exchange names this check, even
 * while a batch runs concurrently, and a check that does not mutate gets one that refuses to
 * write. Salts of this check on this entity alone: what it sends never depends on what ran beside it.
 */
function viewFor(
	loop: CheckLoop,
	{ check, attributed }: Running,
	judged: (operationIds: readonly string[]) => void,
): WriteContext {
	const { client, model } = loop.run.ctx
	const stamp = { check: check.id, purpose: "assertion", subject: loop.run.entity.name } as const
	const writes = (): Client => guardedClient(client.view(stamp), ownRecordsOf(loop.run.ctx), model)
	return {
		...loop.context,
		client: check.mutates === true ? writes() : (client.readOnlyView(stamp) as Client),
		findings: attributed.ownedBy(check.id),
		judged,
		nextSalt: checkSalts(saltIndex(check), loop.run.index),
	}
}

/**
 * How the check ended. An error it threw is mapped to what it means: the network or a credential
 * gone, a fenced request, a value nobody supplied. `undefined` when it ended without a verdict to
 * time or grade; anything else unexpected is the check's own gap.
 */
async function outcomeOf(
	loop: CheckLoop,
	{ check, attributed }: Running,
	view: WriteContext,
): Promise<Outcome | undefined> {
	try {
		return await runOn(check, view, loop.plans.get(check.id))
	} catch (error) {
		/* A record the run depends on was never the check's to change: nothing to judge, not a failure. */
		if (error instanceof HeldRecordError) {
			loop.outcomes.set(check.id, standDown(error.message))
			return undefined
		}
		const unresolved = await unresolvedBy(
			{ attributed, checkId: check.id, ctx: loop.run.ctx, entity: loop.run.entity.name },
			error,
		)
		if (unresolved !== undefined) {
			loop.outcomes.set(check.id, { kind: "unresolved", reason: unresolved })
			return undefined
		}
		const name = loop.run.entity.name
		const detail = messageOf(error)
		return view.findings.gap(check.id, name, { summary: `check "${check.id}" could not complete`, detail })
	}
}

/** Where an error met a check: which check, on which entity, reported under whose attribution. */
export interface Stopped {
	ctx: RunContext
	checkId: string
	entity: string
	attributed: FindingCollector
}

/**
 * Why an error left a check unresolved, reported where it is a cause: the network down, a fenced
 * request, a value oat did not have, a write that would change how a principal signs in, a
 * credential that would not refresh. `undefined` for any other
 * error, which the caller reports as a check that could not complete.
 */
export async function unresolvedBy(stopped: Stopped, error: unknown): Promise<string | undefined> {
	const { attributed, checkId, ctx } = stopped
	const name = stopped.entity
	if (isNetworkError(error)) {
		await ctx.network.note(error, name)
		return "the network failed"
	}
	if (error instanceof FencedError) {
		attributed.blocked("fence", name, {
			summary: `${checkId} was fenced: ${error.request.reason}`,
			cause: `${error.message}. The request was never sent, so ${checkId} could not complete.`,
		})
		return "a request was fenced"
	}
	if (error instanceof MissingValueError || error instanceof ProtectedWriteError) return error.message
	if (!(error instanceof UnsatisfiedSecurity)) return undefined
	/* No credential meets the operation's security: untested, with the reason. */
	if (error.kind === "unsatisfied") return error.reason
	attributed.blocked("auth.blocked" satisfies RunFindingId, name, {
		summary: `${checkId} needed a credential that is BLOCKED`,
		cause: `${error.reason}. ${checkId} could not complete.`,
	})
	return "a credential is BLOCKED"
}

/**
 * A check that reported along the way and then fell through to "asserted" did not assert
 * anything: what it reported is the outcome.
 */
function reported(run: EntityRun, { check, start }: Running, outcome: Outcome): Outcome {
	if (outcome.kind !== "asserted") return outcome
	const found = run.ctx.findings.findings
		.slice(start)
		.find((finding) => finding.check === check.id && finding.entity === run.entity.name && isRootCause(finding))
	if (found === undefined) return outcome
	return { kind: "finding", verdict: found.verdict, ...(outcome.note === undefined ? {} : { note: outcome.note }) }
}

/**
 * Grades the check's subjects by its outcome: those it judged, when it named them, else all it
 * grades. A check that stood down did not pass: the report says why.
 */
function judge(run: EntityRun, check: Check, subjects: Ended): void {
	const { outcome } = subjects
	const { state, grades } = run.ctx
	const entity = run.entity.name
	if ((outcome.kind === "asserted" || outcome.kind === "finding") && outcome.note !== undefined) {
		state.checkNotes.push({ check: check.id, entity, note: outcome.note })
	}
	if (outcome.kind !== "stood-down") {
		grades.graded(subjects.judged, check.id)
		return
	}
	const needs = withLostVariants(run, outcome.reason)
	state.checksSkipped.push({ check: check.id, entity, needs })
	grades.skipped(subjects.graded, needs)
}

/**
 * What a check that stands down for want of cohort data needed, naming the variants that never
 * arrived: the gap points at the seed rather than the API.
 */
/**
 * The check's place among the entity checks, which its salts are drawn from. Operation checks are
 * left out, so registering one never moves an entity check's salts, nor what that check sends.
 */
export function saltIndex(check: Check): number {
	return entityChecks(CHECKS).indexOf(check)
}

export function withLostVariants(run: EntityRun, needs: string): string {
	const lost = run.lostVariants
	if (lost.length === 0 || !/cohort|record/.test(needs)) return needs
	const named = lost.map((variant) => `"${variant}"`).join(", ")
	return `${needs} (the cohort is missing its ${named} variant${lost.length === 1 ? "" : "s"}, which failed to seed)`
}
