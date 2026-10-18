import { defineCheck } from "../../core/define.ts"
import { selectTerm } from "../../../../spec/conventions/select.ts"
import type { EffectiveQueryCapabilities } from "../../../../spec/query/effective.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q, resolvedCaps } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const selectUnknownFieldRejected = defineCheck<{
	policy: NonNullable<NonNullable<EffectiveQueryCapabilities["select"]>["unknown"]>
	requested: string[]
	projection: Record<string, string>
}>({
	plan: (ctx) => {
		const policy = resolvedCaps(ctx).select?.unknown
		if (policy === undefined) return cannot()
		const requested = [ctx.identity, "oat_no_such_select_xyz"]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ policy, projection, requested })
	},
	dependsOn: ["select.projection-honoured", "error.malformed-filter-not-5xx"],
	id: "select.unknown-field-rejected",
	needs: "`select.unknown` declared",
	subjects: subjectsOf.list,
	async run(ctx, { policy, projection }): Promise<Outcome> {
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: 5 }), ...projection })
		if (policy === "reject") {
			const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
			if (refused !== null) return refused
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown select field was not rejected",
				`select.unknown=reject but the probe returned ${result.exchange.status}.`,
				[result.exchange],
			)
		}
		if (result.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "unknown select field was rejected under ignore")
		}
		const extras = Object.keys(result.items[0] ?? {}).filter((key) => key === "oat_no_such_select_xyz")
		if (extras.length === 0) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"unknown select field was honoured under ignore",
			"select.unknown=ignore should drop the undeclared name, not return it.",
			[result.exchange],
		)
	},
})
