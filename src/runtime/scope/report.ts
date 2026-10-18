import type { OperationModel } from "../../spec/graph/types.ts"
import { staticSubjects } from "./entities.ts"
import { gradingOf } from "./grading.ts"
import { operationFor } from "./operation-for.ts"
import { reasonFor } from "./reason.ts"
import { sufficiencyOf } from "./sufficiency.ts"
import type { CoverageInput, OperationCoverage, ScopeReport, SupportUse } from "./types.ts"

function coverageOf(input: CoverageInput, graded: ReadonlySet<string>, operationId: string): OperationCoverage {
	/* Every id the report covers is an operationId of the model. */
	const op = input.model.byOperationId.get(operationId) as OperationModel
	const grading = gradingOf(input, operationId)
	const { failed, gaps, inconclusive, passed, suppressed, status } = grading
	const reason = reasonFor(input, { grading, inScope: graded.has(operationId), op })
	const evidence = status === "passed" ? input.ledger.evidence.get(operationId) : undefined
	const proof = evidence === undefined ? undefined : { ...sufficiencyOf(op, evidence), evidence }
	return {
		checks: { failed, gaps, inconclusive, passed, suppressed },
		entity: op.entity,
		findings: grading.defects.length,
		operationId,
		reason,
		status,
		...(proof === undefined
			? reason === null
				? {}
				: { why: reason }
			: {
					evidence: proof.evidence,
					sufficiency: proof.sufficiency,
					tier: proof.evidence.observation === undefined ? ("contract" as const) : ("verified" as const),
					why: proof.why,
				}),
	}
}

/** Operations a targeted run called without grading, with how many calls failed. */
function supportOf(input: CoverageInput): SupportUse[] {
	const { model, scope } = input
	const support = new Map<string, SupportUse>()
	for (const exchange of input.transcript) {
		const named = exchange.operationId === undefined ? undefined : model.byOperationId.get(exchange.operationId)
		const op = named ?? operationFor(model, exchange, input.baseUrl)
		if (op === null || scope.targets.has(op.operationId)) continue
		const use = support.get(op.operationId) ?? { calls: 0, non2xx: 0, operationId: op.operationId }
		use.calls++
		if (exchange.status < 200 || exchange.status >= 300) {
			use.non2xx++
			use.firstFailure ??= { requestId: exchange.requestId, status: exchange.status }
		}
		support.set(op.operationId, use)
	}
	return [...support.values()].sort((a, b) => a.operationId.localeCompare(b.operationId))
}

export function buildScopeReport(input: CoverageInput): ScopeReport {
	const { model, scope } = input
	const graded = new Set<string>()
	for (const entity of scope.entities) for (const id of staticSubjects(entity, model)) graded.add(id)

	const ids = scope.mode === "targeted" ? [...scope.targets].sort() : model.operations.map((op) => op.operationId)
	return {
		excluded: scope.excluded,
		mode: scope.mode,
		operations: ids.map((operationId) => coverageOf(input, graded, operationId)),
		originsSkipped: [],
		requested: scope.requested,
		support: scope.mode === "targeted" ? supportOf(input) : [],
	}
}
