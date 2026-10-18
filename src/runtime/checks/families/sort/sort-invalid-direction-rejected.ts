import { defineCheck } from "../../core/define.ts"
import { sortSpec, sortTerm } from "../../../../spec/conventions.ts"
import { renderUnknownDirection } from "../../../../spec/sort-render.ts"
import type { Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"

/** A direction token no sort grammar has. */
const UNKNOWN_DIRECTION = "oatsideways"

/**
 * A sort direction the declared grammar does not have must be refused. Read as ascending instead,
 * a caller asking for an order the backend cannot give gets a different one and is never told.
 */
export const sortInvalidDirectionRejected = defineCheck<{ control: string; order: string }>({
	plan: (ctx) => {
		const conventions = conv(ctx)
		if (conventions.order === undefined || conventions.sortDeclared !== true) return cannot()
		const field = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		if (field === undefined) return cannot("a sortable field")
		const order = renderUnknownDirection(sortSpec(conventions), field, UNKNOWN_DIRECTION)
		if (order === null) return cannot("a sort grammar with a token for each direction")
		return ready({ control: sortTerm(conventions, field, "asc"), order })
	},
	dependsOn: ["sort.order-is-applied"],
	id: "sort.invalid-direction-rejected",
	needs: "a declared sort grammar with a token for each direction",
	subjects: subjectsOf.list,
	async run(ctx, { control, order }): Promise<Outcome> {
		const result = await list(asProbe(ctx), q(ctx, { limit: pageSize(ctx), order }))
		if (result.exchange.status >= 500) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"an unknown sort direction produces a server error",
				`order=${order} returned ${result.exchange.status}; a rejected input should be 4xx.`,
				[result.exchange],
			)
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		const ascending = await list(ctx, q(ctx, { limit: pageSize(ctx), order: control }))
		const same = ids(result.items, ctx.identity).join(",") === ids(ascending.items, ctx.identity).join(",")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"an unknown sort direction is accepted",
			`order=${order} returned ${result.exchange.status}` +
				(same ? " in ascending order, so the direction was read as ascending" : "") +
				". A direction the declared grammar does not have must be refused, not guessed.",
			[ascending.exchange, result.exchange],
		)
	},
})
