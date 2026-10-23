import { emptyCapabilities } from "../../../spec/query/merge.ts"
import { describeWithheld, queryOver, restoreWithheld, type Withheld } from "../../../spec/query/sendable.ts"
import { type Outcome, standDown } from "../../finding.ts"
import { resolvedCaps } from "../query/capabilities.ts"
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
	if (!planned.ok) return standDown(planNeeds(check, ctx, planned))
	return runOn(check, ctx, planned.value)
}

/**
 * What a check whose plan cannot run needed: the query parameters the list does not declare, when
 * their absence is what stopped it; else what the plan says; else the check's own needs.
 */
export function planNeeds(check: Check, ctx: WriteContext, planned: { needs?: string }): string {
	return withheldNeeds(check, ctx) ?? planned.needs ?? check.needs ?? "an unstated precondition"
}

/**
 * The parameters a plan that cannot run is missing, when their absence is what stopped it: the
 * plan applies once the withheld capabilities are put back. Each is tried alone first, so the
 * reason names only what this check needed; one needing several together names them all. Planned
 * as the scheduler plans (`planOn`): a check that reads the listing, on an entity without one,
 * still needs the list, whatever was withheld.
 */
function withheldNeeds(check: Check, ctx: WriteContext): string | undefined {
	const withheld = ctx.withheld ?? []
	const applies = (back: readonly Withheld[]): boolean => planOn(check, restored(ctx, back)).ok
	if (withheld.length === 0 || !applies(withheld)) return undefined
	const alone = withheld.filter((item) => applies([item]))
	return describeWithheld(alone.length === 0 ? withheld : alone)
}

function restored(ctx: WriteContext, back: readonly Withheld[]): WriteContext {
	/* An entity with no list holds no capabilities of its own; `planOn` still says it needs one. */
	const current = isListed(ctx) ? resolvedCaps(ctx) : emptyCapabilities()
	const capabilities = restoreWithheld(current, back)
	return { ...ctx, capabilities, query: queryOver(ctx.query, capabilities) }
}
