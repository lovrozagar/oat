import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { storedFieldsUnknown } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, FOUNDATIONS, MOVING_FILTER } from "../../query/capabilities.ts"
import { readSettled, setOf } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import type { SetRead } from "../../sets/read.ts"
import { pickOrderedField } from "./fields.ts"

export const filterOrderedTriplePartitions: Check<{
	field: string
	threshold: number
	lt: Record<string, string>
	eq: Record<string, string>
	gt: Record<string, string>
}> = defineCheck<{
	field: string
	threshold: number
	lt: Record<string, string>
	eq: Record<string, string>
	gt: Record<string, string>
}>({
	plan: (ctx) => {
		const unverified = storedFieldsUnknown(ctx)
		if (unverified !== undefined) return unverified
		const picked = pickOrderedField(ctx)
		if (picked === null) return cannot()
		const threshold = [...new Set(picked.values)].sort((a, b) => a - b)[Math.floor(picked.values.length / 2)]
		if (threshold === undefined) return cannot()
		const conventions = conv(ctx)
		const field = picked.field.field
		const lt = filterTerm(conventions, { field, op: "lt", value: threshold })
		const eq = filterTerm(conventions, { field, op: "eq", value: threshold })
		const gt = filterTerm(conventions, { field, op: "gt", value: threshold })
		if (lt === null || eq === null || gt === null) return cannot("a filter grammar that can express lt, eq and gt")
		return ready({ eq, field, gt, lt, threshold })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		...FOUNDATIONS,
		"filter.equality-selects-exactly-one",
		"filter.numeric-comparison-is-numeric",
	],
	id: "filter.ordered-triple-partitions",
	lists: true,
	needs: "an ordered field that allows `lt`, `eq`, and `gt`",
	subjects: subjectsOf.list,
	async run(ctx, { eq, field, gt, lt }): Promise<Outcome> {
		const partitions = (reads: SetRead[]): boolean => {
			const [a, l, e, h] = reads as [SetRead, SetRead, SetRead, SetRead]
			const parts = [setOf(l.items, ctx.identity), setOf(e.items, ctx.identity), setOf(h.items, ctx.identity)]
			const seen = new Set<string>()
			for (const part of parts)
				for (const id of part) {
					if (seen.has(id)) return false
					seen.add(id)
				}
			return ids(a.items, ctx.identity).every((id) => {
				const record = ctx.records.find((row) => idOf(row, ctx.identity) === id)
				return record === undefined || typeof record[field] !== "number" || seen.has(id)
			})
		}
		const reads = await readSettled(ctx, [{}, lt, eq, gt], partitions)
		if (reads === "rejected")
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the triple listings was rejected")
		if (reads === "incomplete") {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		if (reads === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_FILTER)
		/* One read per term, in the order the terms were given. */
		const [all, lower, equal, higher] = reads as [SetRead, SetRead, SetRead, SetRead]
		const sets = [setOf(lower.items, ctx.identity), setOf(equal.items, ctx.identity), setOf(higher.items, ctx.identity)]
		const overlap = firstOverlap(sets)
		if (overlap.length > 0) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "lt / eq / gt are not pairwise disjoint",
				detail: `${overlap.length} record(s) appear in more than one of ${field} lt/eq/gt.`,
				evidence: [lower.last.exchange, equal.last.exchange, higher.last.exchange],
			})
		}
		const union = new Set(sets.flatMap((set) => [...set]))
		const expected = ids(all.items, ctx.identity).filter((id) => {
			const record = ctx.records.find((row) => idOf(row, ctx.identity) === id)
			return record !== undefined && typeof record[field] === "number"
		})
		const missing = expected.filter((id) => !union.has(id))
		if (missing.length === 0) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "lt ∪ eq ∪ gt does not cover the numeric set",
			detail: `${missing.length} numeric record(s) match none of the three predicates.`,
			evidence: [all.last.exchange, lower.last.exchange, equal.last.exchange, higher.last.exchange],
		})
	},
})

/** The records the first pair of sets shares, taking pairs in order; empty when all are disjoint. */
function firstOverlap(sets: readonly Set<string>[]): string[] {
	for (const [i, left] of sets.entries()) {
		for (const right of sets.slice(i + 1)) {
			const overlap = [...left].filter((id) => right.has(id))
			if (overlap.length > 0) return overlap
		}
	}
	return []
}
