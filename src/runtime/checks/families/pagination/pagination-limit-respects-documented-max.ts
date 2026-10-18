import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const limitRespectsMax = defineCheck<{ max: number; limitParam: string }>({
	plan: (ctx) => {
		const max = ctx.query?.maxLimit
		const limitParam = conv(ctx).limit
		/* Unless the collection holds more records than the cap, an uncapped backend and a
		 * capped one return the same thing and the check would prove nothing. */
		if (max === undefined || limitParam === undefined || ctx.records.length <= max) return cannot()
		return ready({ limitParam, max })
	},
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.limit-respects-documented-max",
	needs: "a declared maxLimit, and more records than it",
	subjects: subjectsOf.list,
	async run(ctx, { limitParam, max }): Promise<Outcome> {
		/* Deliberately past the cap — the one request that may break the documented bound. */
		const result = await list(asProbe(ctx), { [limitParam]: max + 50 })
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		if (result.items.length <= max) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"page size exceeds the documented maximum",
			`limit=${max + 50} returned ${result.items.length} records; the document caps limit at ` +
				`${max}. Either the cap is not enforced or the document overstates it.`,
			[result.exchange],
		)
	},
})
