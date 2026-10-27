/**
 * Every configured scenario that touches the run's scope, in order: its steps run until one fails
 * or the run is told to stop, and what they observed is graded.
 */

import type { Scenario } from "../../config/types/steps.ts"
import { failureOf, ScenarioStopped } from "./failure.ts"
import { gradeScenario, proveCalled, type Stop } from "./grade.ts"
import { wait } from "./poll.ts"
import { startScenario } from "./state.ts"
import { runStep } from "./step.ts"
import type { ScenarioInput, ScenarioRun } from "./types.ts"
import { scenarioCheckId, stepOperation } from "./validate.ts"

export async function runScenarios(input: ScenarioInput): Promise<void> {
	const sleep = input.sleep ?? wait
	for (const scenario of input.scenarios) {
		if (input.stopped?.() === true) return
		const graded = scenario.covers.filter((id) => input.mode === "full" || input.inScope(id))
		const reaches = touches(input, scenario)
		if (graded.length === 0 && !reaches) continue
		const check = scenarioCheckId(scenario)
		input.checksRun.add(check)
		if (blockedBy(input, scenario, { check, graded })) continue
		const run = startScenario(input, scenario, sleep)
		const ended = await runSteps(run)
		/* Stopped from outside: what completed is graded; nothing unreached is a verdict. */
		if (ended === "stopped") {
			proveCalled(run, graded, check)
			return
		}
		gradeScenario(run, graded, ended)
	}
}

/*
 * A scenario that sends as a principal BLOCKED at sign-in, itself or in a step, is not run: it is
 * BLOCKED by that principal, and what it covers stays ungraded. True when it was.
 */
function blockedBy(
	input: ScenarioInput,
	scenario: Scenario,
	at: { check: string; graded: readonly string[] },
): boolean {
	const named = [
		scenario.principal,
		...scenario.steps.map((step) => ("principal" in step ? step.principal : undefined)),
	]
	const principal = named.find((id) => id !== undefined && input.blocked.has(id))
	if (principal === undefined) return false
	const cause = `principal "${principal}" is BLOCKED: ${input.blocked.get(principal) as string}`
	input.findings
		.attributed([...at.graded])
		.ownedBy(at.check)
		.blocked(at.check, scenario.id, {
			cause,
			summary: `scenario "${scenario.id}" sends as a principal that is BLOCKED`,
		})
	return true
}

/** True when a step of the scenario calls an operation in scope. */
function touches(input: ScenarioInput, scenario: Scenario): boolean {
	return scenario.steps.some((step) => {
		const id = stepOperation(step)
		return id !== undefined && input.inScope(id)
	})
}

/** The scenario's steps in order: where one failed, `"stopped"` when the run was told to stop, else `null`. */
async function runSteps(run: ScenarioRun): Promise<Stop | "stopped" | null> {
	for (const [index, step] of run.scenario.steps.entries()) {
		try {
			if (run.input.stopped?.() === true) throw new ScenarioStopped()
			await runStep(run, step, index)
		} catch (error) {
			if (error instanceof ScenarioStopped) return "stopped"
			return { failure: failureOf(error), index }
		}
	}
	return null
}
