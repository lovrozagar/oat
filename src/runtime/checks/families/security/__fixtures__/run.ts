import { type Outcome, standDown } from "../../../../finding.ts"
import type { OperationCheck } from "../../../core/check.ts"
import type { OperationWriteContext } from "../../../core/operation-context.ts"

/** Plans an operation check and, when it applies, runs it: what the security stage does for one check. */
export function runOperationCheck(check: OperationCheck, ctx: OperationWriteContext): Promise<Outcome> {
	const planned = check.plan(ctx)
	if (!planned.ok) return Promise.resolve(standDown(planned.needs ?? check.needs ?? "an unstated precondition"))
	return check.run(ctx, planned.value)
}
