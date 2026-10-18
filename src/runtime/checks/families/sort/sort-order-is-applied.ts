import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { observeTextOrder, sortedUnder } from "../../query/order.ts"
import { list } from "../../sets/list.ts"

export const orderChangesResult = /* @__PURE__ */ defineCheck<{ field: string }>({
	plan: (ctx) => {
		const field = ctx.query?.sortable.find((f) => f !== ctx.identity) ?? ctx.query?.sortable[0]
		return field === undefined || ctx.records.length <= 2 ? cannot() : ready({ field })
	},
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "sort.order-is-applied",
	needs: "an `order` parameter and a sortable field",
	subjects: subjectsOf.list,
	async run(ctx, { field }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const ascending = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "asc") }))
		if (ascending.exchange.status >= 400 || ascending.items.length < 2)
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the sorted listing was rejected or held fewer than two records",
			)

		const values = ascending.items.map((item) => item[field])
		if (values.some((value) => value === undefined))
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sort field is absent from the listed records")
		const order = sortedUnder(ctx, field, values)
		if (order !== null) {
			/* An ignored order can come back ascending by accident — a server's own tiebreak on
			 * this very field does it — but not ascending and descending at once. */
			const descending = await list(ctx, q(ctx, { limit, order: sortTerm(conv(ctx), field, "desc") }))
			const reversed = descending.items.map((item) => item[field])
			const distinct = new Set(values.map((value) => JSON.stringify(value))).size
			if (descending.exchange.status < 400 && distinct > 1 && JSON.stringify(reversed) === JSON.stringify(values)) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"order is accepted but has no effect",
					`order=${field}.asc and order=${field}.desc returned the same sequence of "${field}" ` +
						"values. The listing comes back in one fixed order whatever is asked for.",
					[ascending.exchange, descending.exchange],
				)
			}
			observeTextOrder(ctx, field, order, values)
			return ASSERTED
		}

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"order is accepted but the result is not sorted",
			`order=${field}.asc returned records whose "${field}" values are not ascending: ` +
				`${values
					.slice(0, 5)
					.map((v) => JSON.stringify(v))
					.join(", ")}. A sort parameter the ` +
				"backend ignores silently gives every caller arbitrary ordering.",
			[ascending.exchange],
		)
	},
})
