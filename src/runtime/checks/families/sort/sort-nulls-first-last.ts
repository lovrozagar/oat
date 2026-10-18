import { defineCheck } from "../../core/define.ts"
import { sortTermWithNulls } from "../../../../spec/conventions.ts"
import { type EffectiveFilterField, fieldAllowsNulls } from "../../../../spec/query-capabilities.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, resolvedCaps } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"

export const sortNullsFirstLast = /* @__PURE__ */ defineCheck<{
	field: EffectiveFilterField
	firstClause: string | null
	lastClause: string | null
}>({
	plan: (ctx) => {
		if (conv(ctx).order === undefined || sortTermWithNulls(conv(ctx), "x", "asc", "first") === null) return cannot()
		const field = resolvedCaps(ctx).sortable.find(
			(item) =>
				(fieldAllowsNulls(item, resolvedCaps(ctx), "first") || fieldAllowsNulls(item, resolvedCaps(ctx), "last")) &&
				ctx.records.some((row) => row[item.field] === null || row[item.field] === undefined),
		)
		if (field === undefined) return cannot()
		const placed = (where: "first" | "last"): string | null =>
			fieldAllowsNulls(field, resolvedCaps(ctx), where) ? sortTermWithNulls(conv(ctx), field.field, "asc", where) : null
		/* The grammar has a nulls token and the field allows at least one placement, so at least
		 * one clause is written. */
		return ready({ field, firstClause: placed("first"), lastClause: placed("last") })
	},
	dependsOn: ["sort.order-is-applied", "sort.reverse-symmetry"],
	id: "sort.nulls-first-last",
	needs: "a declared nulls token, a dotted sort grammar, and a null in the cohort",
	subjects: subjectsOf.list,
	async run(ctx, { field, firstClause, lastClause }): Promise<Outcome> {
		const limit = pageSize(ctx)
		if (firstClause !== null) {
			const clause = firstClause
			const result = await collectSet(ctx, limit, {}, { order: clause })
			if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "nullsfirst listing was rejected")
			const first = result.items[0]
			if (first !== undefined && first[field.field] !== null && first[field.field] !== undefined) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"nullsfirst did not put nulls first",
					`order=${clause} started with ${JSON.stringify(first[field.field])}.`,
					[result.last.exchange],
				)
			}
		}
		if (lastClause !== null) {
			const clause = lastClause
			const result = await collectSet(ctx, limit, {}, { order: clause })
			if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "nullslast listing was rejected")
			/* The last record of a partial walk is not the last record of the set. */
			if (!result.complete) {
				return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
			}
			const last = result.items.at(-1)
			if (last !== undefined && last[field.field] !== null && last[field.field] !== undefined) {
				ctx.findings.backend(
					this.id,
					ctx.entityName,
					"nullslast did not put nulls last",
					`order=${clause} ended with ${JSON.stringify(last[field.field])}.`,
					[result.last.exchange],
				)
			}
		}
		return ASSERTED
	},
})
