import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world.ts"
import { cannot, ready } from "../../core/plan.ts"
import { NO_IDENTITY, subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, filterIdentity, identityIsFilterable, pageSize, q } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"

export const equalityFilterSelectsOne = defineCheck<{
	id: string
	field: string
	term: Record<string, string>
}>({
	plan: (ctx) => {
		const target = ctx.records[0]
		if (!filterable(ctx) || !identityIsFilterable(ctx) || target === undefined) return cannot()
		const id = idOf(target, ctx.identity)
		if (id === undefined) return cannot(NO_IDENTITY)
		const field = filterIdentity(ctx)
		const term = filterTerm(conv(ctx), field, "eq", id)
		return term === null
			? cannot("a filter grammar that can express equality on the identity")
			: ready({ field, id, term })
	},
	dependsOn: ["query.filter-selects-from-whole-set", "list.read-after-write"],
	id: "filter.equality-selects-exactly-one",
	needs: "a `filter` parameter that accepts the identity field",
	subjects: subjectsOf.list,
	async run(ctx, { field, id, term }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		/* A rejected filter is not a wrong answer. If the backend says this field is not
		 * filterable, that is a capability statement — the gap belongs to x-query, which is
		 * already reported, not here. Reading a 4xx as "returned zero records" invents a defect. */
		if (result.exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the equality filter was rejected")
		const got = ids(result.items, ctx.identity)
		if (got.length === 1 && got[0] === id) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"equality filter on the identity does not select exactly one record",
			`filter=${field}.eq.${id} returned ${got.length} records (${got.slice(0, 5).join(", ")})`,
			[result.exchange],
		)
	},
})
