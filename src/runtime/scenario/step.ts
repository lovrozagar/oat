/**
 * One scenario step: its binds first, then a value delivered outside HTTP, a hook only a person or
 * a browser can answer, or a request.
 */

import type { ExternalStep, OutOfBandStep, ScenarioStep } from "../../config/types/steps.ts"
import { interpolate } from "../steps/interpolate.ts"
import { resolveOutOfBandValue, triggerSentAt } from "../steps/out-of-band.ts"
import { StepFailure } from "./failure.ts"
import { requestStep } from "./request.ts"
import type { ScenarioRun } from "./types.ts"
import { isExternal, isOutOfBand } from "./validate.ts"

export async function runStep(run: ScenarioRun, step: ScenarioStep, index: number): Promise<void> {
	for (const [name, literal] of Object.entries("bind" in step && step.bind !== undefined ? step.bind : {})) {
		run.scope[name] = String(interpolate(literal, run.scope))
	}
	if (isOutOfBand(step)) return outOfBandStep(run, step)
	if (isExternal(step)) return externalStep(run, step, index)
	return requestStep(run, step, index)
}

async function outOfBandStep(run: ScenarioRun, step: OutOfBandStep): Promise<void> {
	const { input, scope } = run
	const address = String(interpolate(step.outOfBand.address, scope))
	const since = step.outOfBand.sentEarlier === true ? undefined : triggerSentAt(run.sent, address)
	scope[step.outOfBand.as] = await resolveOutOfBandValue(input.hooks.resolveOutOfBand, address, {
		kind: step.outOfBand.kind,
		label: `scenario "${run.scenario.id}"`,
		scope: { ...scope },
		...(since === undefined ? {} : { since }),
		...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
	})
}

async function externalStep(run: ScenarioRun, step: ExternalStep, index: number): Promise<void> {
	const { hooks } = run.input
	if (hooks.external === undefined) {
		throw new StepFailure(`step ${index + 1} needs hooks.external for "${step.external}"`, [], [])
	}
	const value = await hooks.external(
		step.external,
		interpolate(step.input ?? {}, run.scope, run.objects) as Record<string, unknown>,
	)
	if (value === null || value === "") {
		throw new StepFailure(`hooks.external("${step.external}") returned nothing`, [], [])
	}
	run.scope[step.as] = value
	if (/^\s*[[{]/.test(value)) {
		try {
			run.objects.set(step.as, JSON.parse(value))
		} catch {
			/* A string that only looks like JSON stays a string. */
		}
	}
}
