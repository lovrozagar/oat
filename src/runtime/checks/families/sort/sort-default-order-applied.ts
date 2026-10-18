import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { MOVING, pageSize, resolvedCaps } from "../../query/capabilities.ts"
import { collectSet, settlePair } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"

export const sortDefaultOrderApplied = defineCheck<{ defaultOrder: string }>({
	plan: (ctx) => {
		const defaultOrder = resolvedCaps(ctx).sort?.defaultOrder ?? ctx.query?.defaultOrder
		return defaultOrder === undefined || ctx.records.length <= 1 ? cannot() : ready({ defaultOrder })
	},
	dependsOn: ["sort.order-is-applied", "pagination.page-walk-covers-set"],
	id: "sort.default-order-applied",
	needs: "a declared defaultOrder and a complete walk",
	subjects: subjectsOf.list,
	async run(ctx, { defaultOrder }): Promise<Outcome> {
		const limit = pageSize(ctx)
		let implicit = await collectSet(ctx, limit)
		let explicit = await collectSet(ctx, limit, {}, { order: defaultOrder })
		if (implicit === null || explicit === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "default-order walk was rejected")
		}
		const settled = await settlePair(ctx.identity, implicit, explicit, {
			first: () => collectSet(ctx, limit, {}, { fresh: true }),
			second: () => collectSet(ctx, limit, {}, { order: defaultOrder, fresh: true }),
		})
		if (settled === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING)
		if (settled === null) return ctx.findings.unresolved(this.id, ctx.entityName, "default-order walk was rejected")
		implicit = settled.first
		explicit = settled.second
		if (!implicit.complete || !explicit.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the walk is incomplete, so default order cannot be compared",
			)
		}
		if (ids(implicit.items, ctx.identity).join(",") === ids(explicit.items, ctx.identity).join(",")) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"omitting order does not match defaultOrder",
			`defaultOrder=${defaultOrder} produced a different sequence than the implicit listing.`,
			[implicit.last.exchange, explicit.last.exchange],
		)
	},
})
