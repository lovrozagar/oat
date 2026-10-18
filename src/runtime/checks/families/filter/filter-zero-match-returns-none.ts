import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { absentId, NO_ABSENT_ID } from "../../payloads/identity.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, filterIdentity, identityIsFilterable, pageSize, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const zeroMatchFilter = defineCheck<{ term: Record<string, string> }>({
	plan: (ctx) => {
		if (!filterable(ctx) || !identityIsFilterable(ctx)) return cannot()
		const missing = absentId(ctx)
		if (missing === null) return cannot(NO_ABSENT_ID)
		const term = filterTerm(conv(ctx), { field: filterIdentity(ctx), op: "eq", value: missing })
		return term === null ? cannot("a filter grammar that can express equality on the identity") : ready({ term })
	},
	dependsOn: ["query.filter-selects-from-whole-set", "list.read-after-write"],
	id: "filter.zero-match-returns-none",
	needs: "a `filter` parameter that accepts the identity field",
	subjects: subjectsOf.list,
	async run(ctx, { term }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the zero-match filter was rejected")
		if (result.items.length === 0) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "filter that cannot match returns records anyway",
			detail:
				`a filter on a value no record holds returned ${result.items.length} records, so the ` +
				"predicate is not being applied",
			evidence: [result.exchange],
		})
	},
})
