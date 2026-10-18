/**
 * A scenario's running state: the principal it sends as, its scope, and the values its steps
 * keep whole.
 */

import type { Scenario } from "../../config/types/steps.ts"
import { isBytes } from "../auth.ts"
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
	const own = principalOf(input, scenario, scenario.principal ?? input.defaultPrincipal)
	return {
		calls: new Map(),
		context: {
			client: input.client,
			hooks: input.hooks,
			model: input.model,
			principalId: scenario.principal ?? input.defaultPrincipal,
			...(input.originClients === undefined ? {} : { originClients: input.originClients }),
			...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
		},
		headers: own.headers,
		input,
		objects: new Map(),
		observations: new Map(),
		scenario,
		/* The principal's roots (organization, project …) are there from the first step, as in the matrix. */
		scope: { ...own.roots },
		sent: [],
		sleep,
	}
}

/** `value` with every field that is exactly `{name}` of a kept value replaced by that value. */
export function withObjects(objects: ReadonlyMap<string, unknown>, value: unknown): unknown {
	if (typeof value === "string") {
		const name = /^\{([A-Za-z0-9_]+)\}$/.exec(value)?.[1]
		return name !== undefined && objects.has(name) ? objects.get(name) : value
	}
	if (Array.isArray(value)) return value.map((item) => withObjects(objects, item))
	if (isBytes(value)) return value
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withObjects(objects, item)]))
	}
	return value
}
