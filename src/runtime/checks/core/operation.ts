/* Helpers an operation check plans with. */

import { isParamSegment, segmentsOf } from "../../../spec/graph/segments.ts"
import type { OperationModel } from "../../../spec/graph/types.ts"
import { READS } from "../../../spec/methods.ts"
import type { OperationCheckBase } from "./check.ts"
import type { OperationContext, ProbePlacement, Probed, WriteTarget } from "./operation-context.ts"
import { cannot, type Plan, ready } from "./plan.ts"

/** Whether `op` reads: a probe of it may run anywhere. Any other method is a write, probed only on a target. */
export function isReadMethod(op: OperationModel): boolean {
	return READS.has(op.method.toUpperCase())
}

/**
 * Where one probe, a check planned on an operation, runs. A collection read needs nothing the run
 * made, so it runs before the lanes, concurrently. A read of one record runs after them, on a record
 * the run created, still concurrently. A write, and every probe of a check that changes a
 * credential, runs after them alone and in order.
 */
export function placementOf(
	check: Pick<OperationCheckBase<unknown>, "mutatesCredentials">,
	op: OperationModel,
): ProbePlacement {
	if (check.mutatesCredentials === true || !isReadMethod(op)) return "write"
	return isParamSegment(segmentsOf(op.path).at(-1) ?? "") ? "item-read" : "read"
}

/** The record a write or item-read probe sends to, or a stand-down naming what is missing. */
export function targetPlan(ctx: OperationContext): Plan<WriteTarget> {
	const { operation, target, untargeted, untargetedBy } = ctx
	if (target !== undefined) return ready(target)
	return cannot(untargeted ?? `a record this run created that ${operation.operationId} can be sent to`, {
		blockedBy: untargetedBy,
	})
}

/** Whether a probe credential was refused, with the reason the check is untested for. */
export function isUntested<T extends object>(probed: Probed<T>): probed is { untested: string } {
	return "untested" in probed
}
