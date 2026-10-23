import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { pageSize, q } from "../../query/capabilities.ts"
import { envelopeValue, list } from "../../sets/list.ts"

/**
 * The reported total must be consistent with the page it accompanies.
 *
 * A count that reads zero beside a non-empty payload is not a rounding difference — it is a
 * separate query answering a different question, and every UI that renders "N results" from it
 * shows a number contradicted by the rows directly beneath.
 */
export const countIsConsistentWithPage: Check = defineCheck({
	plan: (ctx) => when(ctx.records.length > 0),
	dependsOn: ["list.read-after-write"],
	id: "count.consistent-with-returned-page",
	lists: true,
	needs: "a total-count field in the list envelope",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the listing was rejected")
		const reported = envelopeValue(ctx, result, "total")
		if (typeof reported !== "number") return standDown("the listing reports no total")
		const returned = result.items.length
		if (returned === 0) return ctx.findings.unresolved(this.id, ctx.entityName, "the listing returned nothing to count")
		if (reported >= returned) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "reported count is smaller than the number of records returned",
			detail:
				`the response carries count=${reported} while returning ${returned} record(s) in the same ` +
				`body${envelopeValue(ctx, result, "hasMore") === true ? " and hasMore=true" : ""}. The total is being ` +
				"computed by a query that disagrees with the one producing the rows, so any caller " +
				"rendering a result count contradicts the list it is labelling.",
			evidence: [result.exchange],
		})
	},
})
