import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { absentId, NO_ABSENT_ID } from "../../payloads/identity.ts"
import { asProbe } from "../../planning/refusal.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"

export const deleteMissingIs404 = defineCheck<{ deleteOp: OperationModel; missing: string }>({
	plan: (ctx) => {
		if (ctx.deleteOp === undefined) return cannot()
		const missing = absentId(ctx)
		return missing === null ? cannot(NO_ABSENT_ID) : ready({ deleteOp: ctx.deleteOp, missing })
	},
	mutates: true,
	id: "delete.absent-record-returns-404",
	needs: "a delete operation",
	subjects: subjectsOf.delete,
	async run(ctx, { deleteOp, missing }): Promise<Outcome> {
		const params = { ...ctx.scope, ...itemParamFor(ctx, missing) }
		const exchange = await asProbe(ctx).client.request("DELETE", fillPath(deleteOp.path, params), {
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, deleteOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		if (exchange.status === 404 || exchange.status === 410 || exchange.status === 400) return ASSERTED
		if (exchange.status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"deleting a nonexistent record crashes",
				`DELETE of an id that was never created returned ${exchange.status}; it should be 404.`,
				[exchange],
			)
		}
		if (exchange.status >= 300)
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"deleting an absent record was refused for another reason",
			)
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"deleting a nonexistent record reports success",
			`DELETE of an id that was never created returned ${exchange.status}. Callers cannot ` +
				"distinguish a real deletion from a no-op, which hides broken client state.",
			[exchange],
		)
	},
})
