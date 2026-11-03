import type { Scenario, ScenarioAssert, ScenarioStep } from "../config/types/steps.ts"

/** One scenario's steps, read the way a config's own unit tests ask about them. */
export interface ScenarioView {
	readonly scenario: Scenario
	readonly steps: readonly ScenarioStep[]
	/** The first step calling `operationId` whose fields include `where`, deep; -1 when none does. */
	indexOf(operationId: string, where?: object): number
	/** Every step calling `operationId`, with its index. */
	calls(operationId: string): Array<{ index: number; step: ScenarioStep }>
	/** Every assert, flattened, in step order. */
	asserts(): ScenarioAssert[]
	/** Whether the scenario covers `operationId`, calls it, and a later assert names it in `observes`. */
	observes(operationId: string): boolean
}

/* `actual` holds every field `expected` has, deep; arrays match item by item, at the same length. */
function includes(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((item, i) => includes(actual[i], item))
		)
	}
	if (expected === null || typeof expected !== "object") return Object.is(actual, expected)
	if (actual === null || typeof actual !== "object") return false
	return Object.entries(expected).every(([key, value]) => includes((actual as Record<string, unknown>)[key], value))
}

const operationOf = (step: ScenarioStep): string | undefined => ("operationId" in step ? step.operationId : undefined)

const assertsOf = (step: ScenarioStep): ScenarioAssert[] =>
	"assert" in step && step.assert !== undefined ? [step.assert].flat() : []

/** The scenario `id` among `scenarios`, as a view its unit tests query. */
export function stepsOf(scenarios: readonly Scenario[], id: string): ScenarioView {
	const scenario = scenarios.find((candidate) => candidate.id === id)
	if (scenario === undefined) {
		throw new Error(`no scenario "${id}" among: ${scenarios.map((candidate) => candidate.id).join(", ")}`)
	}
	const { steps } = scenario
	const calls = (operationId: string): Array<{ index: number; step: ScenarioStep }> =>
		steps.flatMap((step, index) => (operationOf(step) === operationId ? [{ index, step }] : []))
	return {
		asserts: () => steps.flatMap(assertsOf),
		calls,
		indexOf: (operationId, where = {}) =>
			steps.findIndex((step) => operationOf(step) === operationId && includes(step, where)),
		observes: (operationId) => {
			const first = calls(operationId)[0]?.index
			if (first === undefined || !scenario.covers.includes(operationId)) return false
			return steps
				.slice(first + 1)
				.flatMap(assertsOf)
				.some((assert) => assert.observes?.includes(operationId) === true)
		},
		scenario,
		steps,
	}
}
