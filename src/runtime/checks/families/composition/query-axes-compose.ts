import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, pageSize } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { sortFieldBeside, type Subset, subsetPlan } from "./plans.ts"

/**
 * Query axes must compose: a filter and a sort applied together must agree with each applied alone.
 *
 * Every other query check exercises one axis in isolation, and that is where the isolation stops
 * being realistic. Real backends break at the *combination*: adding a sort changes which index the
 * planner picks and the filter stops being applied; a cursor is resolved before the filter, so page
 * two leaks rows the predicate excluded; a count is computed on the unfiltered set the moment an
 * order is present. Each of those passes a suite that only ever tests one axis at a time.
 *
 * The property asserted is compositional, so it needs no ground truth: filtering then sorting must
 * yield exactly the same *set* as filtering alone — reordered, but never a different membership.
 * A sort is not a predicate, and it must not behave as one.
 */
export const queryAxesCompose = /* @__PURE__ */ defineCheck<Subset & { sortField: string }>({
	plan: (ctx) => {
		if (!filterable(ctx) || conv(ctx).order === undefined || ctx.records.length <= 2) return cannot()
		if ((ctx.query?.sortable.length ?? 0) === 0) return cannot()
		const subset = subsetPlan(ctx)
		return subset.ok ? ready({ ...subset.value, sortField: sortFieldBeside(ctx, subset.value.field) }) : subset
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		/* Each axis has to work alone before "they disagree when combined" means anything. */
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"select.projection-honoured",
		/* Both sides are gathered by walking pages, so a walk that skips or repeats records
		 * changes the membership being compared for reasons unrelated to composition. */
		"pagination.page-walk-covers-set",
	],
	id: "query.axes-compose",
	needs: "a filterable field, a sortable field, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, sortField, term }): Promise<Outcome> {
		const conventions = conv(ctx)
		const limit = pageSize(ctx)

		/*
		 * Both sides gathered across pages. Comparing single pages would compare two *windows* of
		 * the same set — a sorted page and an unsorted one legitimately hold different records once
		 * the set is larger than one page, and the difference would be read as a dropped filter.
		 */
		const filtered = await collectSet(ctx, limit, term)
		const both = await collectSet(ctx, limit, term, { order: sortTerm(conventions, sortField, "desc") })
		if (filtered === null || both === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"combining a filter with a sort was rejected, so the two cannot be compared",
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
		const missing = [...alone].filter((id) => !combined.has(id))
		const extra = [...combined].filter((id) => !alone.has(id))
		if (missing.length === 0 && extra.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"adding a sort changes which records a filter returns",
			`filter on "${field}" alone matched ${alone.size} record(s); the same filter with ` +
				`order=${sortField} desc matched ${combined.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Appeared: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"Ordering must reorder a result, never change its membership — a filter that only " +
				"holds while unsorted is one an index or query plan is silently dropping.",
			[filtered.last.exchange, both.last.exchange],
		)
	},
})
