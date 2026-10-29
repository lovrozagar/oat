import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, MOVING_COLLECTION, pageSize, q } from "../../query/capabilities.ts"
import { collectSet, sameSet, setOf, settlePair } from "../../sets/compare.ts"
import { overlapPlan, selectionPlan, type Subset } from "./plans.ts"

export const queryFilterSearchSortSelectCompose: Check<
	Subset & { token: string; sortField: string; requested: string[]; projection: Record<string, string> }
> = defineCheck<Subset & { token: string; sortField: string; requested: string[]; projection: Record<string, string> }>(
	{
		plan: (ctx) => {
			const c = conv(ctx)
			if (!filterable(ctx) || c.search === undefined || c.order === undefined || c.select === undefined) return cannot()
			if ((ctx.query?.selectable.length ?? 0) === 0 || ctx.records.length <= 2) return cannot()
			const sortField = ctx.query?.sortable.find((name) => name !== ctx.identity) ?? ctx.query?.sortable[0]
			if (sortField === undefined) return cannot()
			return andThen(overlapPlan(ctx), (overlap) => {
				const extra = ctx.query?.selectable.find((name) => name !== ctx.identity)
				const requested = extra === undefined ? [ctx.identity] : [ctx.identity, extra]
				return andThen(selectionPlan(ctx, requested), (projection) =>
					ready({ ...overlap, projection, requested, sortField }),
				)
			})
		},
		dependsOn: [
			"query.filter-selects-from-whole-set",
			"query.search-and-filter-compose",
			"query.axes-compose",
			"query.filter-and-select-compose",
			"query.sort-and-select-compose",
			"query.filter-sort-select-compose",
			"query.filter-search-sort-compose",
			"query.filter-search-select-compose",
			"pagination.page-walk-covers-set",
		],
		id: "query.filter-search-sort-select-compose",
		lists: true,
		needs: "all four list axes declared and at least three records",
		subjects: subjectsOf.list,
		async run(ctx, { projection, sortField, term, token }): Promise<Outcome> {
			const conventions = conv(ctx)
			const searched = q(ctx, { search: token }) as Record<string, string>
			const readBase = (fresh = false) => collectSet(ctx, pageSize(ctx), { ...term, ...searched }, { fresh })
			const readCombined = (fresh = false) =>
				collectSet(
					ctx,
					pageSize(ctx),
					{ ...term, ...projection, ...searched },
					{ order: sortTerm(conventions, { direction: "asc", field: sortField }), fresh },
				)
			const firstBase = await readBase()
			const firstCombined = await readCombined()
			if (firstBase === null || firstCombined === null) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "four-axis probe was rejected")
			}
			if (!firstBase.complete || !firstCombined.complete) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"a side of the comparison is larger than the walk covers",
				)
			}
			/* A disagreement is read again: a collection another writer moved is no defect of composition. */
			const pair = await settlePair(
				ctx.identity,
				{ first: firstBase, second: firstCombined },
				{
					first: () => readBase(true),
					second: () => readCombined(true),
				},
			)
			if (pair === null) return ctx.findings.unresolved(this.id, ctx.entityName, "four-axis probe was rejected")
			if (pair === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_COLLECTION)
			const { first: base, second: combined } = pair
			if (combined.items.some((item) => item[ctx.identity] === undefined)) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "projection omitted the identity")
			}
			if (sameSet(setOf(base.items, ctx.identity), setOf(combined.items, ctx.identity))) return ASSERTED
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "filter ∩ search membership changes when sort and select join",
				detail: `the four-axis listing returned ${combined.items.length}; filter+search alone returned ${base.items.length}.`,
				evidence: [base.last.exchange, combined.last.exchange],
			})
		},
	},
)
