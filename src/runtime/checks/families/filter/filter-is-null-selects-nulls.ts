import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import type { EffectiveFilterField } from "../../../../spec/query/effective.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, FOUNDATIONS, MOVING_FILTER } from "../../query/capabilities.ts"
import { holdsSomeNulls } from "../../query/order.ts"
import { readSettled, sameSet } from "../../sets/compare.ts"
import type { SetRead } from "../../sets/read.ts"
import { fieldsAllowing, knownHits } from "./fields.ts"

function mixedNullField(ctx: CheckContext, field: string): boolean {
	if (ctx.softDelete !== null && field === ctx.softDelete) return false
	return holdsSomeNulls(ctx, field)
}

export const filterIsNullSelectsNulls = defineCheck<{
	field: EffectiveFilterField
	nullTerm: Record<string, string>
	notNullTerm: Record<string, string>
}>({
	plan: (ctx) => {
		const field = fieldsAllowing(ctx, "is").find((item) => mixedNullField(ctx, item.field))
		if (field === undefined) return cannot()
		const conventions = conv(ctx)
		const nullTerm = filterTerm(conventions, { field: field.field, op: "is", value: "null" })
		const notNullTerm = filterTerm(conventions, { field: field.field, op: "is", value: "notnull" })
		if (nullTerm === null || notNullTerm === null) return cannot("a filter grammar that can express is.null")
		return ready({ field, notNullTerm, nullTerm })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS],
	id: "filter.is-null-selects-nulls",
	needs: "a field that allows `is` and a cohort that contains a null",
	subjects: subjectsOf.list,
	async run(ctx, { field, notNullTerm, nullTerm }): Promise<Outcome> {
		const expectedOf = () =>
			new Set(
				ctx.records
					.filter((row) => row[field.field] === null || row[field.field] === undefined)
					.flatMap((row) => idOf(row, ctx.identity) ?? []),
			)
		const reads = await readSettled(ctx, [{}, nullTerm, notNullTerm], (sets) => {
			const [, n, p] = sets as [SetRead, SetRead, SetRead]
			const got = knownHits(n.items, ctx)
			return sameSet(expectedOf(), got) && ![...got].some((id) => knownHits(p.items, ctx).has(id))
		})
		if (reads === "rejected")
			return ctx.findings.unresolved(this.id, ctx.entityName, "an is.null / is.notnull listing was rejected")
		if (reads === "incomplete") {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		if (reads === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_FILTER)
		/* One read per term, in the order the terms were given. */
		const [, nulls, present] = reads as [SetRead, SetRead, SetRead]
		const expectedNulls = new Set(
			ctx.records
				.filter((row) => row[field.field] === null || row[field.field] === undefined)
				.flatMap((row) => idOf(row, ctx.identity) ?? []),
		)
		const gotNulls = knownHits(nulls.items, ctx)
		const overlap = [...gotNulls].filter((id) => knownHits(present.items, ctx).has(id))
		if (!sameSet(expectedNulls, gotNulls) || overlap.length > 0) {
			ctx.findings.backend(this.id, ctx.entityName, {
				summary: "is.null / is.notnull do not partition on nulls",
				detail:
					`is.null returned ${gotNulls.size} record(s); ${expectedNulls.size} cohort rows are null. ` +
					(overlap.length > 0 ? `${overlap.length} appear on both sides.` : ""),
				evidence: [nulls.last.exchange, present.last.exchange],
			})
		}
		return ASSERTED
	},
})
