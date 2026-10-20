/**
 * Declared flows. The matrix reaches what the document lets it infer; a scenario is the config
 * saying how to reach the rest — a passkey ceremony, a paid checkout, an invite accepted by a
 * second user. oat runs the steps and grades what they observed. It never learns the product.
 */

import type { ExternalStep, OutOfBandStep, Scenario, ScenarioStep } from "../../config/types/steps.ts"

export function scenarioCheckId(scenario: Scenario): string {
	return `scenario.${scenario.id}`
}

export function isExternal(step: ScenarioStep): step is ExternalStep {
	return "external" in step
}

export function isOutOfBand(step: ScenarioStep): step is OutOfBandStep {
	return "outOfBand" in step
}

export function stepOperation(step: ScenarioStep): string | undefined {
	return "operationId" in step && typeof step.operationId === "string" ? step.operationId : undefined
}

/** The secondary origin a step is sent to, or undefined for the main document. */
function stepOriginOf(step: ScenarioStep): string | undefined {
	return "origin" in step && typeof step.origin === "string" && step.origin !== "" ? step.origin : undefined
}

/* An anonymous step sends no credential, so a scheme it names would be silently dropped. */
function refuseAnonymousScheme(scenario: Scenario, step: ScenarioStep, index: number): void {
	if (!("anonymous" in step) || step.anonymous !== true || step.scheme === undefined) return
	throw new Error(
		`oat: scenario "${scenario.id}" step ${index + 1} is anonymous, so it cannot send the "${step.scheme}" scheme`,
	)
}

/**
 * Fails fast on a scenario that names what it cannot grade — before any request is sent. A step on
 * another origin names that origin's operation and is checked against its document; it supports
 * the scenario but never covers a main operation.
 */
export function assertScenarios(
	scenarios: readonly Scenario[],
	known: (operationId: string, origin?: string) => boolean,
): void {
	const seen = new Set<string>()
	for (const scenario of scenarios) {
		if (seen.has(scenario.id)) throw new Error(`oat: two scenarios share the id "${scenario.id}"`)
		seen.add(scenario.id)
		const called = calledOperations(scenario, known)
		for (const id of scenario.covers) {
			if (!called.has(id)) throw new Error(`oat: scenario "${scenario.id}" covers ${id} but no step calls it`)
		}
	}
}

/** The main operations a scenario's steps call, each checked against the document it names. */
function calledOperations(
	scenario: Scenario,
	known: (operationId: string, origin?: string) => boolean,
): ReadonlySet<string> {
	const called = new Set<string>()
	for (const [index, step] of scenario.steps.entries()) {
		refuseAnonymousScheme(scenario, step, index)
		const id = stepOperation(step)
		if (id === undefined) continue
		const origin = stepOriginOf(step)
		if (!known(id, origin)) {
			const where = origin === undefined ? "the document" : `the "${origin}" origin's document`
			throw new Error(`oat: scenario "${scenario.id}" calls ${id}, which is not in ${where}`)
		}
		if (origin === undefined) called.add(id)
	}
	return called
}
