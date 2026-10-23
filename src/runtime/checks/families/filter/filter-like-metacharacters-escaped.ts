import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { filterSpec, filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, filterableNames } from "../../query/capabilities.ts"
import { readSet } from "../../sets/read.ts"

function firstFilterable(ctx: CheckContext, predicate: (name: string) => boolean): string | null {
	return filterableNames(ctx).find(predicate) ?? null
}

export const likeEscaping: Check<{ field: string; likeTerm: Record<string, string> }> = defineCheck<{
	field: string
	likeTerm: Record<string, string>
}>({
	plan: (ctx) => {
		if (!filterable(ctx) || ctx.records.length <= 1) return cannot()
		const field = firstFilterable(ctx, (name) => (ctx.query?.searchable ?? []).includes(name))
		if (field === null) return cannot("a field that is both filterable and searchable")
		/* A literal `%` is not a wildcard in this grammar — `*` is, or the value is a bare substring.
		 * Matching everything means the value was interpolated into a LIKE pattern unescaped. Where
		 * the grammar declares `%` its wildcard, matching everything is the answer, not a leak. */
		if (filterSpec(conv(ctx)).likeWildcard === "%") return cannot("a like operator that reads % literally")
		const likeTerm = filterTerm(conv(ctx), { field, op: "like", value: "%" })
		return likeTerm === null ? cannot("a filter grammar with a like operator") : ready({ field, likeTerm })
	},
	/* The tell is "the filtered result equals the whole listing". Where the listing is already
	 * wrong, that comparison is against a set the backend never served correctly. */
	dependsOn: ["query.filter-selects-from-whole-set", "pagination.page-walk-covers-set", "list.read-after-write"],
	id: "filter.like-metacharacters-escaped",
	needs: "a `filter` parameter supporting a like operator",
	subjects: subjectsOf.list,
	async run(ctx, { field, likeTerm }): Promise<Outcome> {
		const total = await readSet(ctx)
		const probe = await readSet(ctx, likeTerm)
		if (probe.status !== "ok") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the like probe was rejected with ${probe.last.exchange.status}, so escaping was never exercised`,
			)
		}
		if (total.status !== "ok" || !total.complete || !probe.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		if (total.items.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the unfiltered listing returned nothing, leaving no baseline to compare the probe against",
			)
		}
		if (probe.items.length < total.items.length) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "LIKE metacharacters in a filter value are not escaped",
			detail:
				`filter=${field}.like.%25 matched all ${probe.items.length} records. "%" is a literal in ` +
				"this grammar; treating it as a wildcard means user input is being interpolated into a " +
				"pattern unescaped.",
			evidence: [total.last.exchange, probe.last.exchange],
		})
	},
})
