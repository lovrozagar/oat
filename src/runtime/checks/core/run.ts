import { type Outcome, standDown } from "../../finding.ts"
import type { Check } from "./check.ts"
import type { WriteContext } from "./context.ts"

/**
 * The salts one check draws on one entity: the check's place in the registry, the entity's in the
 * model, and a count. Two check runs never share one, by construction, and a run draws the same
 * sequence every time.
 */
export function checkSalts(checkIndex: number, entityIndex: number): () => string {
	let drawn = 0
	return () => `${checkIndex}.${entityIndex}.${(drawn++).toString(36)}`
}

/** Plans a check and, when it applies, runs it — what the scheduler does, for one check. */
export async function runCheck(check: Check, ctx: WriteContext): Promise<Outcome> {
	const planned = check.plan(ctx)
	if (!planned.ok) return standDown(planned.needs ?? check.needs ?? "an unstated precondition")
	return check.run(ctx, planned.value)
}
