import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const limitBoundsPageSize = defineCheck({
	plan: (ctx) => when(conv(ctx).limit !== undefined && ctx.records.length > 2),
	dependsOn: ["list.read-after-write"],
	id: "pagination.limit-bounds-page-size",
	needs: "a page-size query parameter named `limit`",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(ctx, q(ctx, { limit: 2 }))
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the listing was rejected")
		if (result.items.length <= 2) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "limit does not bound the number of records returned",
			detail:
				`limit=2 returned ${result.items.length} records. A page size the backend accepts and ` +
				"ignores means callers cannot bound response size, and every paging loop is wrong.",
			evidence: [result.exchange],
		})
	},
})
