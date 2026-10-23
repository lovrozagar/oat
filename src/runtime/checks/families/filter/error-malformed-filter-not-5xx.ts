import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { asProbe } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { filterable, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const malformedFilterNot5xx: Check = defineCheck({
	plan: (ctx) => when(filterable(ctx)),
	id: "error.malformed-filter-not-5xx",
	needs: "a way to express a filter — a filter expression parameter, or filterable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(asProbe(ctx), q(ctx, { filter: "((((", limit: 10 }))
		if (result.exchange.status < 500) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "malformed filter input produces a server error",
			detail:
				`a syntactically invalid filter returned ${result.exchange.status}. Bad client input must ` +
				"be rejected with a 4xx; a 5xx means the parser is throwing rather than validating.",
			evidence: [result.exchange],
		})
	},
})
