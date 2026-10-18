import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions.ts"
import type { Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, FOUNDATIONS, q, resolvedCaps } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"
import { pickFieldForOp } from "./fields.ts"

export const filterInOverLimitRejected = defineCheck<{
	field: string
	max: number
	term: Record<string, string>
}>({
	plan: (ctx) => {
		const max = resolvedCaps(ctx).maxInValues
		const picked = pickFieldForOp(ctx, "in", 1)
		if (max === undefined || picked === null) return cannot()
		const members = Array.from({ length: max + 1 }, (_, i) => `oat-over-limit-${i}`)
		const term = filterTerm(conv(ctx), picked.field.field, "in", members)
		return term === null
			? cannot("a filter grammar that can express in()")
			: ready({ field: picked.field.field, max, term })
	},
	dependsOn: [...FOUNDATIONS, "error.malformed-filter-not-5xx"],
	id: "filter.in-over-limit-rejected",
	needs: "`maxInValues` declared and a field that allows `in`",
	subjects: subjectsOf.list,
	async run(ctx, { field, max, term }): Promise<Outcome> {
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: 5 }), ...term })
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an over-limit in() list was accepted",
			`maxInValues=${max} but ${field}.in with ${max + 1} members returned ${result.exchange.status}.`,
			[result.exchange],
		)
	},
})
