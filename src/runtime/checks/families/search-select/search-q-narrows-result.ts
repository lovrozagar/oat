import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const searchNarrowsResult: Check<{ field: string }> = defineCheck<{ field: string }>({
	plan: (ctx) => {
		const field = ctx.query?.searchable[0]
		return conv(ctx).search === undefined || field === undefined || ctx.records.length <= 2
			? cannot()
			: ready({ field })
	},
	dependsOn: ["list.read-after-write"],
	id: "search.q-narrows-result",
	lists: true,
	needs: "a free-text `q` parameter and declared searchable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const limit = pageSize(ctx)
		const all = await list(ctx, q(ctx, { limit }))
		if (all.items.length < 2)
			return ctx.findings.unresolved(this.id, ctx.entityName, "fewer than two records to narrow")

		/* A token no record can contain: a correct search returns nothing. */
		const result = await list(ctx, q(ctx, { limit, search: "zzqqxx-oat-no-match-token" }))
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the search was rejected")
		if (result.items.length === 0) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "free-text search returns records that cannot match",
			detail:
				`q= a token no record contains returned ${result.items.length} of ${all.items.length} ` +
				"records, so the search term is being ignored rather than applied.",
			evidence: [all.exchange, result.exchange],
		})
	},
})
