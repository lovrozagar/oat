import { type Outcome, standDown } from "../../finding.ts"
import type { Check } from "./check.ts"
import { isListed, type WriteContext } from "./context.ts"
import { cannot, type Plan } from "./plan.ts"

/** What a check that reads the entity's listing needs, on an entity that has none. */
export const NEEDS_LIST = "a list operation"

/**
 * The salts one check draws on one entity: the check's place in the registry, the entity's in the
 * model, and a count. Two check runs never share one, by construction, and a run draws the same
 * sequence every time.
 */
export function checkSalts(checkIndex: number, entityIndex: number): () => string {
	let drawn = 0
	return () => `${checkIndex}.${entityIndex}.${(drawn++).toString(36)}`
}

/** The check's plan on the entity; a check that reads the listing cannot plan on an entity without one. */
export function planOn(check: Check, ctx: WriteContext): Plan<unknown> {
	if (check.lists !== true) return check.plan(ctx)
	return isListed(ctx) ? check.plan(ctx) : cannot(NEEDS_LIST)
}

/** Runs a check its plan let through; a check that reads the listing stands down on an entity without one. */
export function runOn(check: Check, ctx: WriteContext, plan: unknown): Promise<Outcome> {
	if (check.lists !== true) return check.run(ctx, plan)
	return isListed(ctx) ? check.run(ctx, plan) : Promise.resolve(standDown(NEEDS_LIST))
}

/** Plans a check and, when it applies, runs it — what the scheduler does, for one check. */
export async function runCheck(check: Check, ctx: WriteContext): Promise<Outcome> {
	const planned = planOn(check, ctx)
	if (!planned.ok) return standDown(planned.needs ?? check.needs ?? "an unstated precondition")
	return runOn(check, ctx, planned.value)
}
