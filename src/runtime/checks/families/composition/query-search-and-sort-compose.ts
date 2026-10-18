import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, MOVING, pageSize, q } from "../../query/capabilities.ts"
import { sortedUnder } from "../../query/order.ts"
import { listAgain, listAll, sameSet, setOf, settlePair } from "../../sets/compare.ts"

export const querySearchAndSortCompose = defineCheck<{
	searchField: string
	sortField: string
	token: string
}>({
	plan: (ctx) => {
		if (conv(ctx).search === undefined || conv(ctx).order === undefined) return cannot()
		const searchField = ctx.query?.searchable[0]
		const sortField = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
		if (searchField === undefined || sortField === undefined) return cannot()
		const token = ctx.records
			.map((row) => row[searchField])
			.find((value): value is string => typeof value === "string" && value.length > 2)
		if (token === undefined) return cannot(`a cohort value of "${searchField}" long enough to search for`)
		return ready({ searchField, sortField, token })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result", "sort.order-is-applied"],
	id: "query.search-and-sort-compose",
	needs: "searchable and sortable fields",
	subjects: subjectsOf.list,
	async run(ctx, { sortField, token }): Promise<Outcome> {
		const search = q(ctx, { limit: pageSize(ctx), search: token })
		const sorted = q(ctx, {
			limit: pageSize(ctx),
			search: token,
			order: sortTerm(conv(ctx), { direction: "asc", field: sortField }),
		})
		const first = await listAll(ctx, search)
		const second = await listAll(ctx, sorted)
		if (first.exchange.status >= 400 || second.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "search+sort probe was rejected")
		}
		if (!first.complete || !second.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		/* A record written between the two reads is the collection moving, not the sort filtering. */
		const settled = await settlePair(
			ctx.identity,
			{ first, second },
			{
				first: () => listAgain(ctx, search),
				second: () => listAgain(ctx, sorted),
			},
		)
		if (settled === null) return ctx.findings.unresolved(this.id, ctx.entityName, "search+sort probe was rejected")
		if (settled === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING)
		const { first: searched, second: combined } = settled
		if (!sameSet(setOf(searched.items, ctx.identity), setOf(combined.items, ctx.identity))) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "adding a sort changes which records a search returns",
				detail: `q=${JSON.stringify(token)} membership changed when order=${sortField} was added.`,
				evidence: [searched.exchange, combined.exchange],
			})
		}
		const values = combined.items.map((item) => item[sortField])
		if (sortedUnder(ctx, sortField, values) !== null) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "search results are not ordered",
			detail: `q + order=${sortField}.asc did not keep ${sortField} ascending.`,
			evidence: [combined.exchange],
		})
	},
})
