import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { selectTerm } from "../../../../spec/conventions/select.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { listAll, sameSet, setOf } from "../../sets/compare.ts"

export const querySearchAndSelectCompose: Check<{
	field: string
	token: string
	requested: string[]
	projection: Record<string, string>
}> = defineCheck<{
	field: string
	token: string
	requested: string[]
	projection: Record<string, string>
}>({
	plan: (ctx) => {
		if (conv(ctx).search === undefined || conv(ctx).select === undefined) return cannot()
		const query = ctx.query
		const field = query?.searchable[0]
		if (query === null || field === undefined || query.selectable.length === 0) return cannot()
		const token = ctx.records
			.map((row) => row[field])
			.find((value): value is string => typeof value === "string" && value.length > 2)
		if (token === undefined) return cannot(`a cohort value of "${field}" long enough to search for`)
		const requested = [ctx.identity, field]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		return projection === null ? cannot() : ready({ field, projection, requested, token })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result", "select.projection-honoured"],
	id: "query.search-and-select-compose",
	lists: true,
	needs: "searchable and selectable fields",
	subjects: subjectsOf.list,
	async run(ctx, { projection, token }): Promise<Outcome> {
		const searched = await listAll(ctx, q(ctx, { limit: pageSize(ctx), search: token }))
		const combined = await listAll(ctx, { ...q(ctx, { limit: pageSize(ctx), search: token }), ...projection })
		if (searched.exchange.status >= 400 || combined.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "search+select probe was rejected")
		}
		if (!searched.complete || !combined.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		if (combined.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "projection omitted the identity")
		}
		if (sameSet(setOf(searched.items, ctx.identity), setOf(combined.items, ctx.identity))) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "adding a select changes which records a search returns",
			detail: `q=${JSON.stringify(token)} alone matched ${searched.items.length}; with select it matched ${combined.items.length}.`,
			evidence: [searched.exchange, combined.exchange],
		})
	},
})
