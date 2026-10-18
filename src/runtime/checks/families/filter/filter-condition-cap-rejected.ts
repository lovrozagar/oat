import { defineCheck } from "../../core/define.ts"
import { filterSpec } from "../../../../spec/conventions.ts"
import { canGroupAnd, type FilterQuery, renderAnd } from "../../../../spec/filter-render.ts"
import type { Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterIdentity, FOUNDATIONS, identityIsFilterable, q, resolvedCaps } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const filterConditionCapRejected = defineCheck<{ max: number; overCap: FilterQuery }>({
	plan: (ctx) => {
		const max = resolvedCaps(ctx).maxFilterConditions
		const conventions = conv(ctx)
		if (max === undefined || conventions.filter === undefined) return cannot()
		if (!canGroupAnd(filterSpec(conventions)) || !identityIsFilterable(ctx)) return cannot()
		const term = { field: filterIdentity(ctx), op: "eq", value: "oat-cap" } as const
		const overCap = renderAnd(
			filterSpec(conventions),
			conventions.filter,
			Array.from({ length: max + 1 }, () => term),
		)
		return overCap === null ? cannot() : ready({ max, overCap })
	},
	dependsOn: [...FOUNDATIONS, "error.malformed-filter-not-5xx"],
	id: "filter.condition-cap-rejected",
	needs: "`maxFilterConditions` declared and a grammar that can group eq terms",
	subjects: subjectsOf.list,
	async run(ctx, { max, overCap }): Promise<Outcome> {
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: 5 }), ...overCap })
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an over-limit filter expression was accepted",
			`maxFilterConditions=${max} but ${max + 1} eq terms returned ${result.exchange.status}.`,
			[result.exchange],
		)
	},
})
