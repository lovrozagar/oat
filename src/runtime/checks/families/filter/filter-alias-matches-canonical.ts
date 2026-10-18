import { defineCheck } from "../../core/define.ts"
import { canWriteFilterOp, filterTerm } from "../../../../spec/conventions/filter.ts"
import { fieldAllows } from "../../../../spec/query/field-ops.ts"
import { isFilterOp } from "../../../../spec/query/ops.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, conv, filterable, FOUNDATIONS, MOVING_FILTER, resolvedCaps } from "../../query/capabilities.ts"
import { readSettled, sameSet, setOf } from "../../sets/compare.ts"
import type { SetRead } from "../../sets/read.ts"

export const filterAliasMatchesCanonical = defineCheck({
	plan: (ctx) => when(Object.keys(resolvedCaps(ctx).aliases).length > 0 && filterable(ctx)),
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.equality-selects-exactly-one"],
	id: "filter.alias-matches-canonical",
	needs: "a declared filter operator alias",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const caps = resolvedCaps(ctx)
		const conventions = conv(ctx)
		for (const [alias, target] of Object.entries(caps.aliases)) {
			if (!isFilterOp(alias) || target === undefined) continue
			const field = resolvedCaps(ctx).filterable.find((item) => fieldAllows(item, target, caps))
			if (field === undefined || !canWriteFilterOp(conventions, alias)) continue
			const sample = ctx.records.find((row) => row[field.field] != null)
			if (sample === undefined) continue
			const value = asTermValue(sample[field.field])
			const aliasTerm = filterTerm(conventions, { field: field.field, op: alias, value })
			const targetTerm = filterTerm(conventions, { field: field.field, op: target, value })
			if (aliasTerm === null || targetTerm === null) continue
			const agree = (pair: SetRead[]): boolean => {
				const [a, b] = pair as [SetRead, SetRead]
				return sameSet(setOf(a.items, ctx.identity), setOf(b.items, ctx.identity))
			}
			const reads = await readSettled(ctx, [aliasTerm, targetTerm], agree)
			if (reads === "rejected") {
				return ctx.findings.unresolved(this.id, ctx.entityName, `alias ${alias} or ${target} was rejected`)
			}
			if (reads === "incomplete") {
				return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
			}
			if (reads === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_FILTER)
			/* One read per term, in the order the terms were given. */
			const [left, right] = reads as [SetRead, SetRead]
			if (!agree(reads)) {
				return ctx.findings.backend(this.id, ctx.entityName, {
					summary: `alias ${alias} does not select the same set as ${target}`,
					detail: `${field.field}.${alias} and ${field.field}.${target} disagreed on membership.`,
					evidence: [left.last.exchange, right.last.exchange],
				})
			}
		}
		return ASSERTED
	},
})
