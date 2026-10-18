/*
 * The credentials StepRunner port, served by the step engine. `credentials` sits below the runtime
 * and cannot import it, so `runtime/run` builds this runner and hands it down: a login or refresh
 * recipe runs its steps through it and reads the credential out of the answer itself.
 */

import type { AuthStep } from "../../config/types/steps.ts"
import { runSteps, type StepAnswer } from "./engine.ts"
import type { StepContext } from "./request.ts"

// matches credentials/ports.ts StepRunner
export interface StepRunner {
	run: (
		steps: readonly AuthStep[],
		at: { principal: string; scope: Readonly<Record<string, string>> },
	) => Promise<{ scope: Record<string, string>; answer: StepAnswer }>
}

/** A runner over `ctx`, running each call's steps as the principal it names. */
export function stepRunner(ctx: Omit<StepContext, "principalId">): StepRunner {
	return {
		run: async (steps, { principal, scope }) => {
			const out = await runSteps({ ...ctx, principalId: principal }, steps, { scope })
			if (out.last === undefined) {
				throw new Error(
					`oat: principal "${principal}" ran its steps without sending a request, so there is no answer to read`,
				)
			}
			return { answer: out.last, scope: out.scope }
		},
	}
}
