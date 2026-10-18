/**
 * How a scenario stops: a step that failed, with what it sent and the operations it blames, or a
 * run told to stop.
 */

import type { Exchange } from "../exchange.ts"

export class StepFailure extends Error {
	constructor(
		message: string,
		readonly evidence: Exchange[],
		readonly blames: string[],
	) {
		super(message)
	}
}

/** The run was told to stop: a step cut short is not a step that failed. */
export class ScenarioStopped extends Error {
	override name = "ScenarioStopped"
}

/** What a step threw, as a failure: its own, or one with no evidence that blames nothing. */
export function failureOf(error: unknown): StepFailure {
	if (error instanceof StepFailure) return error
	return new StepFailure(error instanceof Error ? error.message : String(error), [], [])
}

/** The step's own operation, as the list a failure blames. */
export function blamed(stepOp: string | undefined): string[] {
	return stepOp === undefined ? [] : [stepOp]
}
