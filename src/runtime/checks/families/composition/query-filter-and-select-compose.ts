import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, pageSize } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { projectionPlan, type Subset, subsetPlan } from "./plans.ts"

/**
 * A filter and a sparse fieldset must compose: projecting columns must never change which
 * records match.
 *
 * The failure this catches is a query builder that projects first and then cannot apply a
 * predicate to a column it just omitted, or that takes a different path the moment `fields=` is
 * present and forgets the WHERE. Each axis is correct alone — the filter returns the right set,
 * the select returns the right columns — and together the filter silently vanishes.
 *
 * The oracle is the same compositional property as `queryAxesCompose`: the filter alone
 * and the same filter with a select must return the same **set**. Identity is always requested
 * so the two sides remain comparable.
 */
export const filterAndSelectCompose: Check<Subset & { extra: string; projection: Record<string, string> }> =
	defineCheck<Subset & { extra: string; projection: Record<string, string> }>({
		plan: (ctx) => {
			if (!filterable(ctx) || conv(ctx).select === undefined || ctx.records.length <= 2) return cannot()
			return andThen(subsetPlan(ctx), (subset) =>
				andThen(projectionPlan(ctx), (projected) => ready({ ...subset, ...projected })),
			)
		},
		dependsOn: [
			"query.filter-selects-from-whole-set",
			"list.read-after-write",
			"create.persists-submitted-fields",
			"filter.equality-selects-exactly-one",
			/* If select is accepted and ignored, both sides still carry every column and the
			 * membership comparison remains well-defined — but a backend that has stopped honouring
			 * select at all may also have stopped taking the code path this check is probing. */
			"select.projection-honoured",
			"pagination.page-walk-covers-set",
		],
		id: "query.filter-and-select-compose",
		lists: true,
		needs: "a filterable field, a select parameter, and more than two records",
		subjects: subjectsOf.list,
		async run(ctx, { extra, field, projection, term }): Promise<Outcome> {
			const limit = pageSize(ctx)

			const filtered = await collectSet(ctx, limit, term)
			const both = await collectSet(ctx, limit, { ...term, ...projection })
			if (filtered === null || both === null) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"combining a filter with a select was rejected, so the two cannot be compared",
				)
			}
			if (!filtered.complete || !both.complete) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"the filtered set is larger than the walk covers, so the two runs cannot be compared as whole sets",
				)
			}

			const alone = new Set(ids(filtered.items, ctx.identity))
			const combined = new Set(ids(both.items, ctx.identity))
			/* A projection that omitted the identity makes membership unobservable — that is a
			 * missing column, not a changed set, and select.projection-honoured already owns it. */
			if (both.items.some((item) => item[ctx.identity] === undefined)) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					"the projected page omitted the identity field, so the two sets cannot be compared",
				)
			}
			const missing = [...alone].filter((id) => !combined.has(id))
			const extraIds = [...combined].filter((id) => !alone.has(id))
			if (missing.length === 0 && extraIds.length === 0) return ASSERTED

			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "adding a select changes which records a filter returns",
				detail:
					`filter on "${field}" alone matched ${alone.size} record(s); the same filter with ` +
					`select=${[ctx.identity, extra].join(",")} matched ${combined.size}. ` +
					(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
					(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
					"A projection must change which columns come back, never which rows — a filter " +
					"that only holds while every column is selected is one a query plan is dropping " +
					"once it has to name the columns.",
				evidence: [filtered.last.exchange, both.last.exchange],
			})
		},
	})
