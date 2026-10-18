import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import type { Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"

export const sortUnknownFieldRejected = defineCheck({
	plan: (ctx) => when(conv(ctx).order !== undefined),
	dependsOn: ["error.malformed-filter-not-5xx"],
	id: "sort.unknown-field-rejected",
	needs: "an order parameter",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(
			asProbe(ctx),
			q(ctx, { limit: 5, order: sortTerm(conv(ctx), { direction: "asc", field: "oat_no_such_sort_xyz" }) }),
		)
		if (result.exchange.status >= 500) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "unknown sort field produces a server error",
				detail: `ordering on an undeclared field returned ${result.exchange.status}; a rejected input should be 4xx.`,
				evidence: [result.exchange],
			})
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		const baseline = await list(ctx, q(ctx, { limit: 5 }))
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "unknown sort field is silently ignored",
			detail:
				`order on an undeclared field returned ${result.exchange.status}` +
				(same ? " with the default order, so the field was dropped" : "") +
				".",
			evidence: [baseline.exchange, result.exchange],
		})
	},
})
