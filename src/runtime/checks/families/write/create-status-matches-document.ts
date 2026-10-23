import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { describeSuccess, documentsStatus } from "../../../../spec/graph/statuses.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { createExchange } from "../../payloads/body.ts"
import { subjectsOf } from "../../planning/subjects.ts"

export const createStatusMatchesSpec: Check<{ createOp: OperationModel; success: string[] }> = defineCheck<{
	createOp: OperationModel
	success: string[]
}>({
	plan: (ctx) => {
		const createOp = ctx.createOp
		if (createOp === undefined) return cannot()
		const success = describeSuccess(createOp.statuses)
		return success.length === 0 ? cannot("a success status documented for create") : ready({ createOp, success })
	},
	id: "create.status-matches-document",
	judgesTranscript: true,
	needs: "a create operation",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, success }): Promise<Outcome> {
		const exchange = await createExchange(ctx)
		if (exchange === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "no successful create of this entity was observed")
		if (documentsStatus(createOp.statuses, exchange.status)) return ASSERTED
		return ctx.findings.spec(this.id, ctx.entityName, {
			summary: "create returns a success status the document does not declare",
			detail:
				`${createOp.operationId} returned ${exchange.status}; the document declares ` +
				`${success.join(", ")}. Either the handler or the document is wrong, and clients ` +
				"generated from the spec will not recognise the response.",
			evidence: [exchange],
		})
	},
})
