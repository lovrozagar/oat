import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import {
	conv,
	filterable,
	filterableNames,
	filterIdentity,
	identityIsFilterable,
	pageSize,
} from "../../query/capabilities.ts"
import { nullableField } from "../../query/order.ts"
import { collectSet } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"

export const negationPartitions = defineCheck<{
	field: string
	value: string
	eqTerm: Record<string, string>
	neqTerm: Record<string, string>
}>({
	plan: (ctx) => {
		if (!filterable(ctx) || ctx.records.length <= 1 || !identityIsFilterable(ctx)) return cannot()
		/* Prefer a field with nulls in the cohort: partitioning on the identity can never expose
		 * three-valued-logic bugs, because an identity is never null. */
		const field = nullableField(ctx, filterableNames(ctx)) ?? filterIdentity(ctx)
		const probe = ctx.records.map((r) => r[field]).find((v) => v !== null && v !== undefined)
		if (probe === undefined) return cannot(`a cohort record with a non-null "${field}" to negate`)
		const value = String(probe)
		const eqTerm = filterTerm(conv(ctx), { field, op: "eq", value })
		const neqTerm = filterTerm(conv(ctx), { field, op: "neq", value })
		/* Negation has no representation in an equality-only grammar, so this property simply
		 * cannot be expressed against such an API — better to stand down than to send something
		 * meaningless and read the answer as a defect. */
		if (eqTerm === null || neqTerm === null) return cannot("a filter grammar that can express negation")
		return ready({ eqTerm, field, neqTerm, value })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		/* Partitioning is asserted over field *values*. A backend that drops submitted fields
		 * leaves the cohort without the value the predicate is built from. */
		"create.persists-submitted-fields",
		/* The three sets are gathered across pages, so a walk that skips or repeats records makes
		 * the partition fail for a reason that has nothing to do with the predicate. */
		"pagination.page-walk-covers-set",
	],
	id: "filter.negation-partitions-the-set",
	needs: "a `filter` parameter supporting eq and neq",
	subjects: subjectsOf.list,
	async run(ctx, { eqTerm, field, neqTerm }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const all = await collectSet(ctx, limit)
		const matching = await collectSet(ctx, limit, eqTerm)
		const complement = await collectSet(ctx, limit, neqTerm)
		if (all === null || matching === null || complement === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the partition was rejected",
			)
		}
		/* Set algebra only holds over complete sets. A walk that hit the page cap has seen a
		 * prefix, and the union would legitimately miss whatever lies beyond it. */
		if (!all.complete || !matching.complete || !complement.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the union cannot be compared against the whole set",
			)
		}

		const union = new Set([...ids(matching.items, ctx.identity), ...ids(complement.items, ctx.identity)])
		const expected = new Set(ids(all.items, ctx.identity))
		const overlap = ids(matching.items, ctx.identity).filter((value) =>
			ids(complement.items, ctx.identity).includes(value),
		)

		if (overlap.length > 0) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "a predicate and its negation both match the same record",
				detail:
					`${overlap.length} record(s) appear in both ${field}.eq and ${field}.neq results: ` +
					overlap.slice(0, 3).join(", "),
				evidence: [matching.last.exchange, complement.last.exchange],
			})
		}
		const missing = [...expected].filter((id) => !union.has(id))
		if (missing.length > 0) {
			const nulls = missing.filter((id) => {
				const record = ctx.records.find((r) => idOf(r, ctx.identity) === id)
				return record !== undefined && (record[field] === null || record[field] === undefined)
			})
			ctx.findings.backend(this.id, ctx.entityName, {
				summary: "a predicate and its negation do not cover the full set",
				detail:
					`${missing.length} record(s) match neither ${field}.eq nor ${field}.neq: ` +
					`${missing.slice(0, 3).join(", ")}. ` +
					(nulls.length === missing.length
						? `Every one of them has ${field} = null, so the negated predicate is dropping ` +
							"nulls — SQL evaluates `col <> x` as NULL, not true, unless the query also " +
							"tests `col IS NULL`."
						: "A record must satisfy either a predicate or its negation."),
				evidence: [all.last.exchange, matching.last.exchange, complement.last.exchange],
			})
		}
		return ASSERTED
	},
})
