import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { andThen, when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, pageSize, q } from "../../query/capabilities.ts"
import { collectSet, unlessMoved } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { overlapPlan, type Subset } from "./plans.ts"

/**
 * A structured filter and a free-text search must compose as their intersection.
 *
 * Adding `q` often switches a backend onto a search-index path that does not honor the
 * structured predicate — or the reverse: a filter makes the search term a no-op. Each axis is
 * correct alone; together one of them vanishes. The oracle needs no ground truth: walk each
 * axis, walk both, and the combined set must equal the intersection.
 *
 * The two sides have to overlap without nesting. If the search matches only records the filter
 * already selected, dropping the filter is invisible — the combined set still equals the
 * intersection. The token is chosen so each axis matches something the other does not.
 */
export const searchAndFilterCompose: Check<Subset & { token: string }> = defineCheck<Subset & { token: string }>({
	plan: (ctx) =>
		andThen(
			when(
				filterable(ctx) &&
					conv(ctx).search !== undefined &&
					(ctx.query?.searchable.length ?? 0) > 0 &&
					ctx.records.length > 2,
			),
			() => overlapPlan(ctx),
		),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"pagination.page-walk-covers-set",
	],
	id: "query.search-and-filter-compose",
	lists: true,
	needs: "a filterable field, a free-text search parameter, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, term, token }): Promise<Outcome> {
		const limit = pageSize(ctx)

		const filtered = await collectSet(ctx, limit, term)
		if (filtered === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filtered listing was rejected, so it cannot be compared with a search",
			)
		}
		if (!filtered.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the filtered set is larger than the walk covers")
		}

		const filterIds = new Set(ids(filtered.items, ctx.identity))
		const searched = await collectSet(ctx, limit, q(ctx, { search: token }))
		const both = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		})
		if (searched === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a search was rejected, so the two cannot be compared",
			)
		}
		if (!searched.complete || !both.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}

		const searchIds = new Set(ids(searched.items, ctx.identity))
		const expected = new Set([...filterIds].filter((id) => searchIds.has(id)))
		const got = new Set(ids(both.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED
		const search = q(ctx, { search: token })
		const terms = [{ query: term }, { query: search }, { query: { ...term, ...search } }]
		const moved = await unlessMoved(ctx, this.id, { reads: [filtered, searched, both], terms })
		if (moved !== null) return moved

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "a filter and a search do not compose as their intersection",
			detail:
				`filter on "${field}" matched ${filterIds.size}; q=${JSON.stringify(token)} matched ` +
				`${searchIds.size}; both together matched ${got.size} (intersection is ` +
				`${expected.size}). ` +
				(missing.length > 0 ? `Missing: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Extra: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A structured predicate and a free-text search must narrow each other. When they " +
				"do not, one of them is being dropped the moment the other is present.",
			evidence: [filtered.last.exchange, searched.last.exchange, both.last.exchange],
		})
	},
})
