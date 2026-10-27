/**
 * A scenario's running state: the principal it sends as, its scope, and the values its steps
 * keep whole, which its requests and external inputs send as they are.
 */

import type { Scenario } from "../../config/types/steps.ts"
import type { ScenarioInput, ScenarioPrincipal, ScenarioRun } from "./types.ts"

/** The configured principal `id`; a scenario that names another is refused. */
export function principalOf(input: ScenarioInput, scenario: Scenario, id: string): ScenarioPrincipal {
	const found = input.principals.get(id)
	if (found === undefined)
		throw new Error(`oat: scenario "${scenario.id}" names principal "${id}", which is not configured`)
	return found
}

export function startScenario(
	input: ScenarioInput,
	scenario: Scenario,
	sleep: (ms: number) => Promise<void>,
): ScenarioRun {
	const principal = scenario.principal ?? input.defaultPrincipal
	const own = principalOf(input, scenario, principal)
	/* One map: what a step keeps, every later step's request and input send whole. */
	const objects = new Map<string, unknown>()
	return {
		calls: new Map(),
		context: {
			client: input.client,
			hooks: input.hooks,
			kept: objects,
			model: input.model,
			principalId: principal,
			...(input.originClients === undefined ? {} : { originClients: input.originClients }),
			...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
		},
		input,
		objects,
		observations: new Map(),
		principal,
		scenario,
		/* The parameters bound for the principal (organization, project …) are there from the first step, as in the matrix. */
		scope: { ...own.scope },
		sent: [],
		sleep,
	}
}
