import type { WriteContext } from "../../checks/core/context.ts"
import { CHECKS } from "../../checks/registry.ts"
import { isRootCause } from "../../finding.ts"
import { type Check, type CheckLoop, type PlannedCheck, runCheck, withLostVariants } from "./run-check.ts"
import type { EntityRun } from "./state.ts"

/**
 * Runs every check on the entity, in registry order.
 *
 * Read-only checks accumulate into a batch and fire together; a mutating check flushes the batch
 * and then runs alone. A batch also flushes when the next check depends on something already
 * inside it, so suppression never has to consult a finding that has not landed yet. This is where
 * a live run's time actually goes — dozens of independent GETs against one entity, each paying
 * full network latency for no reason.
 */
export async function runChecks(
	run: EntityRun,
	context: WriteContext,
	/** The registry, in order; a test passes checks of its own. */
	checks: readonly Check[] = CHECKS,
): Promise<void> {
	const loop: SuppressingLoop = {
		context,
		outcomes: new Map(),
		plans: new Map(),
		run,
		suppressedBy: new Map(),
	}
	let batch: PlannedCheck[] = []
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		const pending = batch
		batch = []
		await Promise.all(pending.map((queued) => runCheck(loop, queued)))
	}
	for (const check of checks) {
		if (run.ctx.options.signal?.aborted === true) break
		const graded = planned(loop, check)
		if (graded === null) continue
		const next = { check, graded }
		/* A writer runs alone; so does a check that judges the transcript, once everything queued
		 * before it has finished sending. */
		if (check.mutates === true || check.judgesTranscript === true) {
			await flush()
			if (!suppressed(loop, next)) await runCheck(loop, next)
			continue
		}
		if (check.dependsOn?.some((dependency) => batch.some((queued) => queued.check.id === dependency)) === true) {
			await flush()
		}
		if (!suppressed(loop, next)) batch.push(next)
	}
	await flush()
}

interface SuppressingLoop extends CheckLoop {
	/** Each suppressed check, by the root cause it was suppressed for. */
	suppressedBy: Map<string, string>
}

/**
 * Whether the check applies here: it grades something this run targets, and its plan found what
 * it needs. Out of scope is not a skip — the check could have run, this run was not asked to.
 * Anything else that does not apply is recorded, not dropped: on an API shaped unlike the fixture
 * this is most of the suite, and a silent skip reads exactly like a clean result.
 */
function planned(loop: CheckLoop, check: Check): string[] | null {
	const { run } = loop
	const { ctx, entity } = run
	const graded = check.subjects(entity, ctx.model).filter((id) => ctx.scope.inScope(id) && !ctx.exclusion.excludes(id))
	if (ctx.scope.mode === "targeted" && graded.length === 0) {
		ctx.state.checksOutOfScope.push({ check: check.id, entity: entity.name })
		return null
	}
	const plan = check.plan(loop.context)
	if (plan.ok) {
		loop.plans.set(check.id, plan.value)
		return graded
	}
	const needs = withLostVariants(run, plan.needs ?? check.needs ?? "an unstated precondition")
	ctx.state.checksSkipped.push({ check: check.id, entity: entity.name, needs })
	ctx.grades.skipped(graded, needs)
	return null
}

/**
 * Cascade suppression, transitively.
 *
 * A check whose premise is known broken reports a consequence, not a defect. The subtle part is
 * that suppression has to propagate: if A is suppressed because B failed, then C — which depends
 * on A — must be suppressed too. Consulting only *fired* findings misses this, because A never
 * fired; it was skipped. C then runs against the same broken premise and reports the root cause a
 * second time under its own name.
 *
 * So a check is suppressed when any dependency either failed outright or was itself suppressed,
 * and the reason carried forward names the original cause rather than the intermediate link —
 * which is what the reader has to fix.
 */
function suppressed(loop: SuppressingLoop, { check, graded }: PlannedCheck): boolean {
	const { ctx, entity } = loop.run
	for (const dependency of check.dependsOn ?? []) {
		const because = failed(loop, dependency) ? dependency : loop.suppressedBy.get(dependency)
		if (because === undefined) continue
		loop.suppressedBy.set(check.id, because)
		ctx.state.checksSuppressed.push({ because, check: check.id, entity: entity.name })
		ctx.grades.suppress(graded, check.id)
		return true
	}
	return false
}

/**
 * Only a failed premise suppresses. A dependency that stood down, could not reach a verdict, or
 * was blocked says nothing about whether its premise holds. One not run as a check here may still
 * have been reported against — during seeding, say.
 */
function failed({ outcomes, run }: CheckLoop, dependency: string): boolean {
	const outcome = outcomes.get(dependency)
	if (outcome !== undefined) return outcome.kind === "finding"
	return run.ctx.findings.findings.some(
		(finding) => finding.check === dependency && finding.entity === run.entity.name && isRootCause(finding),
	)
}
