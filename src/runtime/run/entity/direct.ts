import type { EntityModel } from "../../../spec/graph/types.ts"
import type { Outcome } from "../../finding.ts"
import type { RunContext } from "../context.ts"

/* An entity tested by one check of its own rather than the matrix: the root read, the caller's self. */

/** The entity is tested, by this check. */
export function startedTest(ctx: RunContext, entity: EntityModel, check: string): void {
	const { state, progress } = ctx
	state.entitiesTested.push(entity.name)
	progress.entity = entity.name
	progress.check = check
	progress.phase = "test"
	state.checksRun.add(check)
}

/** Grades the operations by how the check ended: one that stood down or was unresolved is skipped. */
export function graded(ctx: RunContext, operations: string[], check: string, outcome: Outcome): void {
	if (outcome.kind === "stood-down" || outcome.kind === "unresolved") {
		ctx.grades.skipped(operations, outcome.reason)
		return
	}
	ctx.grades.graded(operations, check)
}
