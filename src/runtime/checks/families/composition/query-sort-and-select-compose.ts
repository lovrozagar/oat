import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { selectTerm } from "../../../../spec/conventions/select.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q } from "../../query/capabilities.ts"
import { sortedUnder } from "../../query/order.ts"
import { list } from "../../sets/list.ts"

export const querySortAndSelectCompose: Check<{
	field: string
	requested: string[]
	projection: Record<string, string>
}> = defineCheck<{
	field: string
	requested: string[]
	projection: Record<string, string>
}>({
	plan: (ctx) => {
		if (conv(ctx).order === undefined || conv(ctx).select === undefined || ctx.records.length <= 1) return cannot()
		if ((ctx.query?.selectable.length ?? 0) === 0) return cannot()
		const field = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		if (field === undefined) return cannot()
		/* The sort field itself must survive the projection, or the order has nothing to be read off. */
		const requested = field === ctx.identity ? [ctx.identity] : [ctx.identity, field]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ field, projection, requested })
	},
	dependsOn: ["sort.order-is-applied", "select.projection-honoured", "select.requested-fields-present"],
	id: "query.sort-and-select-compose",
	needs: "sortable and selectable fields",
	subjects: subjectsOf.list,
	async run(ctx, { field, projection, requested }): Promise<Outcome> {
		const result = await list(ctx, {
			...q(ctx, { limit: 20, order: sortTerm(conv(ctx), { direction: "asc", field }) }),
			...projection,
		})
		const [first, second] = result.items
		if (result.exchange.status >= 400 || first === undefined || second === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "sort+select probe was rejected")
		}
		const extras = Object.keys(first).filter((key) => !requested.includes(key))
		const values = result.items.map((item) => item[field])
		if (extras.length === 0 && sortedUnder(ctx, field, values) !== null) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "sort and select do not compose",
			detail:
				extras.length > 0
					? `select leaked ${extras.slice(0, 5).join(", ")}.`
					: `order=${field}.asc did not hold under the projection.`,
			evidence: [result.exchange],
		})
	},
})
