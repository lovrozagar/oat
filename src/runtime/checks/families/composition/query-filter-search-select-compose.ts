import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { andThen, ready, when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, pageSize, q } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { overlapPlan, projectionPlan, type Subset } from "./plans.ts"

/**
 * A filter, a search and a select must compose: projecting columns must not change the
 * intersection of filter and search.
 */
export const filterSearchSelectCompose: Check<
	Subset & { token: string; extra: string; projection: Record<string, string> }
> = defineCheck<Subset & { token: string; extra: string; projection: Record<string, string> }>({
	plan: (ctx) =>
		andThen(
			when(
				filterable(ctx) &&
					conv(ctx).search !== undefined &&
					conv(ctx).select !== undefined &&
					(ctx.query?.searchable.length ?? 0) > 0 &&
					ctx.records.length > 2,
			),
			() =>
				andThen(overlapPlan(ctx), (overlap) =>
					andThen(projectionPlan(ctx), (projected) => ready({ ...overlap, ...projected })),
				),
		),
	dependsOn: [
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"search.q-narrows-result",
		"select.projection-honoured",
		"pagination.page-walk-covers-set",
		"query.search-and-filter-compose",
		"query.filter-and-select-compose",
		"query.filter-selects-from-whole-set",
	],
	id: "query.filter-search-select-compose",
	lists: true,
	needs: "a filterable field, a search parameter, a select parameter, and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { extra, field, projection, term, token }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const pair = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
		} as Record<string, string>)
		const triple = await collectSet(ctx, limit, {
			...term,
			...q(ctx, { search: token }),
			...projection,
		} as Record<string, string>)
		if (pair === null || triple === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "combining a filter, a search and a select was rejected")
		}
		if (!pair.complete || !triple.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a side of the comparison is larger than the walk covers")
		}
		if (triple.items.some((item) => item[ctx.identity] === undefined)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the projected page omitted the identity field, so the two sets cannot be compared",
			)
		}

		const expected = new Set(ids(pair.items, ctx.identity))
		const got = new Set(ids(triple.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extraIds = [...got].filter((id) => !expected.has(id))
		if (missing.length === 0 && extraIds.length === 0) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "adding a select changes which records a filter and a search return",
			detail:
				`filter on "${field}" with q=${JSON.stringify(token)} matched ${expected.size}; ` +
				`the same request with select=${[ctx.identity, extra].join(",")} matched ${got.size}. ` +
				(missing.length > 0 ? `Dropped: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extraIds.length > 0 ? `Appeared: ${extraIds.slice(0, 3).join(", ")}. ` : "") +
				"A projection must change columns, never the intersection a filter and a search " +
				"already agreed on.",
			evidence: [pair.last.exchange, triple.last.exchange],
		})
	},
})
