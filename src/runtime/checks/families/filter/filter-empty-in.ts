import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions.ts"
import type { EffectiveQueryCapabilities } from "../../../../spec/query-capabilities.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, FOUNDATIONS, pageSize, q, resolvedCaps } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"
import { pickFieldForOp } from "./fields.ts"

export const filterEmptyIn = /* @__PURE__ */ defineCheck<{
	field: string
	policy: NonNullable<EffectiveQueryCapabilities["emptyIn"]>
	term: Record<string, string>
}>({
	plan: (ctx) => {
		const picked = pickFieldForOp(ctx, "in", 1)
		const policy = resolvedCaps(ctx).emptyIn
		if (picked === null || policy === undefined) return cannot()
		const term = filterTerm(conv(ctx), picked.field.field, "in", [])
		return term === null
			? cannot("a filter grammar that can express an empty in()")
			: ready({ field: picked.field.field, policy, term })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.in-is-union-of-eq"],
	id: "filter.empty-in",
	needs: "`emptyIn` declared and a field that allows `in`",
	subjects: subjectsOf.list,
	async run(ctx, { field, policy, term }): Promise<Outcome> {
		const baseline = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		if (policy === "reject") {
			const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
			if (refused !== null) return refused
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"empty in() was not rejected",
				`emptyIn=reject but ${field}.in.() returned ${result.exchange.status}.`,
				[result.exchange],
			)
		}
		if (result.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "empty in() was rejected under match-none")
		}
		if (result.items.length === 0) return ASSERTED
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"empty in() did not match none",
			`emptyIn=match-none but ${field}.in.() returned ${result.items.length} record(s)` +
				(same ? " — the unfiltered set, so the filter was ignored" : "") +
				".",
			[baseline.exchange, result.exchange],
		)
	},
})
