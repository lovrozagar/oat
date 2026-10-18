import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { idOf } from "../../../world.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, filterIdentity, identityIsFilterable, pageSize, q } from "../../query/capabilities.ts"
import { envelopeValue, list } from "../../sets/list.ts"

export const countMatchesWalk = defineCheck<{ countTerm: Record<string, string> }>({
	plan: (ctx) => {
		if (ctx.records.length <= 1 || !filterable(ctx) || !identityIsFilterable(ctx)) return cannot()
		const targetId = idOf(ctx.records[0], ctx.identity)
		const countTerm = targetId === undefined ? null : filterTerm(conv(ctx), filterIdentity(ctx), "eq", targetId)
		return countTerm === null
			? cannot("a filter grammar that can express equality on the identity")
			: ready({ countTerm })
	},
	/* Compares the reported total against the *filtered* set. Where the filter is ignored the two
	 * agree trivially — both describe the whole collection — so the count cannot be judged until
	 * filtering itself is known to work. */
	dependsOn: ["query.filter-selects-from-whole-set", "list.read-after-write", "filter.equality-selects-exactly-one"],
	id: "count.matches-filtered-set",
	needs: "a total-count field and a `filter` parameter",
	subjects: subjectsOf.list,
	async run(ctx, { countTerm }): Promise<Outcome> {
		const filtered = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...countTerm })
		if (filtered.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the filtered listing was rejected")
		const reported = envelopeValue(ctx, filtered, "total")
		if (typeof reported !== "number") return standDown("the listing reports no total")
		if (reported === filtered.items.length) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"reported count disagrees with the filtered result",
			`filter selected ${filtered.items.length} record(s) but count reported ${reported}. ` +
				"A count that ignores the active filter makes every paginated UI show wrong totals.",
			[filtered.exchange],
		)
	},
})
