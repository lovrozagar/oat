import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { EffectiveQueryCapabilities } from "../../../../spec/query/effective.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q, resolvedCaps } from "../../query/capabilities.ts"
import { listAll, sameSet, setOf, unlessMoved } from "../../sets/compare.ts"

export const searchEmptyQ: Check<{
	policy: NonNullable<EffectiveQueryCapabilities["searchEmpty"]>
}> = defineCheck<{
	policy: NonNullable<EffectiveQueryCapabilities["searchEmpty"]>
}>({
	plan: (ctx) => {
		const policy = resolvedCaps(ctx).searchEmpty
		return conv(ctx).search === undefined || policy === undefined ? cannot() : ready({ policy })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result"],
	id: "search.empty-q",
	lists: true,
	needs: "`searchEmpty` declared",
	subjects: subjectsOf.list,
	async run(ctx, { policy }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const baseline = await listAll(ctx, q(ctx, { limit }))
		const empty = await listAll(ctx, q(ctx, { limit, search: "" }))
		if (policy === "reject") {
			const refused = judgeRefusal(ctx, this.id, ["validation"], empty.exchange)
			if (refused !== null) return refused
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "empty q was not rejected",
				detail: `searchEmpty=reject but q= returned ${empty.exchange.status}.`,
				evidence: [empty.exchange],
			})
		}
		if (empty.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "empty q was rejected")
		}
		if (!baseline.complete || !empty.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		if (sameSet(setOf(empty.items, ctx.identity), setOf(baseline.items, ctx.identity))) return ASSERTED
		const terms = [{ query: q(ctx, {}) }, { query: q(ctx, { search: "" }) }]
		const moved = await unlessMoved(ctx, this.id, { reads: [baseline, empty], terms })
		if (moved !== null) return moved
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "empty q did not match the unfiltered set",
			detail: `searchEmpty=${policy} but q= returned ${empty.items.length} of ${baseline.items.length} records.`,
			evidence: [baseline.exchange, empty.exchange],
		})
	},
})
