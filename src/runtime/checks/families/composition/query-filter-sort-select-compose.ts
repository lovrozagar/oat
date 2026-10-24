import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { andThen, cannot, ready, when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, pageSize } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { projectionBeside, sortFieldBeside, type Subset, subsetPlan } from "./plans.ts"

/**
 * A filter, a sort and a select must compose: adding both extra axes must not change which
 * records the filter matches.
 *
 * Pairwise composition is not enough. A planner that has a working two-axis path and a
 * broken three-axis path — the moment `order` and `fields` are both present, the WHERE is
 * dropped — passes every pair check. The oracle is the same membership property as the
 * pairs: the filter alone and the filter with both extras must return the same set.
 */
export const filterSortSelectCompose: Check<
	Subset & { extra: string; projection: Record<string, string>; sortField: string }
> = defineCheck<Subset & { extra: string; projection: Record<string, string>; sortField: string }>({
	plan: (ctx) =>
		andThen(
			when(
				filterable(ctx) &&
					conv(ctx).order !== undefined &&
					conv(ctx).select !== undefined &&
					(ctx.query?.sortable.length ?? 0) > 0 &&
					ctx.records.length > 2,
			),
			() =>
				andThen(subsetPlan(ctx), (subset) => {
					const projected = projectionBeside(ctx)
					if (projected === null) return cannot("a select grammar that can express a sparse fieldset")
					return ready({ ...subset, ...projected, sortField: sortFieldBeside(ctx, subset.field) })
				}),
		),
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"select.projection-honored",
		"pagination.page-walk-covers-set",
		/* Each pair has to hold before "the triple disagrees" means anything. A pair defect
		 * would also break this request, and reporting it again would name the wrong cause. */
		"query.axes-compose",
		"query.filter-and-select-compose",
		"query.filter-selects-from-whole-set",
	],
	id: "query.filter-sort-select-compose",
	lists: true,
	needs: "a filterable field, a sortable field, a select parameter, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { extra, field, projection, sortField, term }): Promise<Outcome> {
		const conventions = conv(ctx)
		const limit = pageSize(ctx)

		const filtered = await collectSet(ctx, limit, term)
		const triple = await collectSet(
			ctx,
			limit,
			{ ...term, ...projection },
			{ order: sortTerm(conventions, { direction: "desc", field: sortField }) },
		)
		if (filtered === null || triple === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a sort and a select was rejected",
			)
		}
		if (!filtered.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}
		if (triple.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the projected page omitted the identity field, so the two sets cannot be compared",
			)
		}

		const alone = new Set(ids(filtered.items, ctx.identity))
		const combined = new Set(ids(triple.items, ctx.identity))
		const missing = [...alone].filter((id) => !combined.has(id))
		const extraIds = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "adding a sort and a select together changes which records a filter returns",
			detail:
				`filter on "${field}" alone matched ${alone.size}; the same filter with ` +
				`order=${sortField} desc and select=${[ctx.identity, extra].join(",")} matched ` +
				`${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"Each pair composes; the triple must too. A filter that only holds until both a " +
				"sort and a projection are present is one a three-axis query plan is dropping.",
			evidence: [filtered.last.exchange, triple.last.exchange],
		})
	},
})
