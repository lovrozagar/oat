import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { andThen, ready, when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, pageSize, q } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { overlapPlan, sortFieldBeside, type Subset } from "./plans.ts"

/**
 * A filter, a search and a sort must compose: the intersection of filter and search must not
 * change when a sort is added.
 *
 * The search-index path that also tries to honour an ORDER BY is a common place to drop the
 * structured predicate. Pairwise, filter+search and filter+sort both hold; together they do not.
 */
export const filterSearchSortCompose = defineCheck<Subset & { token: string; sortField: string }>({
	plan: (ctx) =>
		andThen(
			when(
				filterable(ctx) &&
					conv(ctx).search !== undefined &&
					conv(ctx).order !== undefined &&
					(ctx.query?.searchable.length ?? 0) > 0 &&
					(ctx.query?.sortable.length ?? 0) > 0 &&
					ctx.records.length > 2,
			),
			() =>
				andThen(overlapPlan(ctx), (overlap) => ready({ ...overlap, sortField: sortFieldBeside(ctx, overlap.field) })),
		),
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"sort.order-is-applied",
		"pagination.page-walk-covers-set",
		"query.search-and-filter-compose",
		"query.axes-compose",
		"query.filter-selects-from-whole-set",
	],
	id: "query.filter-search-sort-compose",
	needs: "a filterable field, a search parameter, a sortable field, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, sortField, term, token }): Promise<Outcome> {
		const conventions = conv(ctx)
		const limit = pageSize(ctx)
		const pair = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		} as Record<string, string>)
		const triple = await collectSet(ctx, limit, { ...term, ...q(ctx, { search: token }) } as Record<string, string>, {
			order: sortTerm(conventions, sortField, "desc"),
		})
		if (pair === null || triple === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "combining a filter, a search and a sort was rejected")
		}
		if (!pair.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}

		const expected = new Set(ids(pair.items, ctx.identity))
		const got = new Set(ids(triple.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort changes which records a filter and a search return",
			`filter on "${field}" with q=${JSON.stringify(token)} matched ${expected.size}; ` +
				`the same request with order=${sortField} desc matched ${got.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A sort must reorder the intersection, never change it.",
			[pair.last.exchange, triple.last.exchange],
		)
	},
})
