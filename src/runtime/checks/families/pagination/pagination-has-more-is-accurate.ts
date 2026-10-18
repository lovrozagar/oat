import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { pageable, q } from "../../query/capabilities.ts"
import { envelopeValue, list } from "../../sets/list.ts"

export const hasMoreIsAccurate = defineCheck({
	plan: (ctx) => when(pageable(ctx) && ctx.records.length > 2),
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.has-more-is-accurate",
	needs: "a way to page forward, and a more-pages signal in the body or a Link header",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const first = await list(ctx, q(ctx, { limit: 1, page: 1 }))
		if (first.exchange.status >= 400 || first.items.length === 0)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the first page was rejected or empty")
		const flag = envelopeValue(ctx, first, "hasMore")
		if (typeof flag !== "boolean") return standDown("the listing has no has-more flag")

		const second = await list(ctx, q(ctx, { limit: 1, page: 2 }))
		const moreExist = second.items.length > 0
		if (flag === moreExist) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			flag
				? "hasMore claims further pages exist when none do"
				: "hasMore claims no further pages while the next page returns records",
			`page 1 at limit=1 reported hasMore=${flag}, but page 2 returned ` +
				`${second.items.length} record(s). Callers that trust the flag will ` +
				(flag ? "request an empty page" : "silently stop after the first page"),
			[first.exchange, second.exchange],
		)
	},
})
