/** Why an operation was not graded, in the words the scope report gives. */

import type { OperationModel } from "../../spec/graph/types.ts"
import { untestableReason } from "./entities.ts"
import type { Grading } from "./grading.ts"
import type { CoverageInput } from "./types.ts"

/** The operation, whether any check in scope grades it, and how its checks ended. */
export interface Ungraded {
	op: OperationModel
	inScope: boolean
	grading: Grading
}

/** Why the graph says no check can grade it, when it does. */
function staticReason(input: CoverageInput, operation: Ungraded): string | undefined {
	const { op } = operation
	return (
		input.scope.untestable.get(op.operationId) ??
		(operation.inScope ? undefined : untestableReason(op, input.model, input.authCreates))
	)
}

function untestedReason(input: CoverageInput, operation: Ungraded): string {
	const { op, grading } = operation
	const { operationId } = op
	const statically = staticReason(input, operation)
	const needs = [...(input.ledger.needs.get(operationId) ?? [])]
	const emptyList = needs.find((need) => need === "the list returned no id")
	/* The contract call actually tried this operation; what stopped it beats a static guess. */
	const tried = needs.find((need) =>
		/^(contract call|destructive call|unresolved |the second user|no way to sign up)/.test(need),
	)
	const uncalled =
		grading.ran.size > 0 && !grading.succeeded
			? `graded by checks, but no request to ${operationId} succeeded`
			: undefined
	const gap = grading.gapFindings[0]
	return (
		uncalled ??
		emptyList ??
		(statically !== undefined && tried !== undefined ? `${statically}; ${tried}` : undefined) ??
		tried ??
		statically ??
		(gap === undefined ? undefined : `coverage gap: ${gap.summary}`) ??
		(needs.length > 0 ? `no check applied: needs ${needs.slice(0, 3).join("; ")}` : "no check exercised it")
	)
}

/** Why the operation was not graded, or `null` when it was. */
export function reasonFor(input: CoverageInput, operation: Ungraded): string | null {
	const { grading } = operation
	if (grading.status === "blocked") {
		return grading.blocked[0]?.detail ?? `suppressed by an earlier failure (${grading.suppressed.join(", ")})`
	}
	return grading.status === "untested" ? untestedReason(input, operation) : null
}
