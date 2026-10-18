/**
 * A scenario's grades: every covered operation it called passes on that call, a failing step
 * fails the operations it blames, and what it never reached is blocked by that step.
 */

import type { StepFailure } from "./failure.ts"
import type { ScenarioRun } from "./types.ts"
import { scenarioCheckId } from "./validate.ts"

/** Where a scenario stopped, and why. */
export interface Stop {
	index: number
	failure: StepFailure
}

/** Each of `ids` the scenario called is graded by it and proved by its call. */
export function proveCalled(run: ScenarioRun, ids: readonly string[], check: string): void {
	const { grades } = run.input
	for (const id of ids) {
		const call = run.calls.get(id)
		if (call === undefined) continue
		grades.graded([id], check)
		const observation = run.observations.get(id)
		grades.prove(id, observation === undefined ? { call: call.seq } : { call: call.seq, observation })
	}
}

/**
 * A finished scenario. A failing step blames its own operation whether or not the scenario covers
 * it: a support step that fails (arming an account, setting the scene) must not stop the scenario
 * in silence.
 */
export function gradeScenario(run: ScenarioRun, graded: readonly string[], stoppedAt: Stop | null): void {
	const { input, scenario } = run
	const check = scenarioCheckId(scenario)
	const failedOps = new Set(
		stoppedAt?.failure.blames.filter((id) => graded.includes(id) || input.mode === "full" || input.inScope(id)) ?? [],
	)
	proveCalled(
		run,
		graded.filter((id) => !failedOps.has(id)),
		check,
	)
	if (stoppedAt === null) return

	const where = `scenario "${scenario.id}" stopped at step ${stoppedAt.index + 1}`
	const { failure } = stoppedAt
	if (failedOps.size > 0) {
		input.grades.graded([...failedOps], check)
		input.findings
			.attributed([...failedOps])
			.ownedBy(check)
			.backend(check, scenario.id, `${where}: ${failure.message}`, failure.message, failure.evidence)
	}
	const unreached = graded.filter((id) => !failedOps.has(id) && !run.calls.has(id))
	if (unreached.length > 0) {
		input.findings
			.attributed(unreached)
			.ownedBy(check)
			.blocked(check, scenario.id, `${where} before calling it`, `${where}: ${failure.message}`)
	}
}
