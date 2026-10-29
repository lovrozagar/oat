import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { storedFieldsUnknown } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, canUseOp, conv, filterable, FOUNDATIONS, MOVING_COLLECTION } from "../../query/capabilities.ts"
import { readSettled, setOf } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import type { SetRead } from "../../sets/read.ts"
import { pickFieldForOp } from "./fields.ts"

export const filterNinComplementsIn: Check<{
	field: string
	members: Array<string | number>
	inTerm: Record<string, string>
	ninTerm: Record<string, string>
}> = defineCheck<{
	field: string
	members: Array<string | number>
	inTerm: Record<string, string>
	ninTerm: Record<string, string>
}>({
	plan: (ctx) => {
		const unverified = storedFieldsUnknown(ctx)
		if (unverified !== undefined) return unverified
		if (!filterable(ctx)) return cannot()
		/* Two members where the cohort has them: a list of one cannot tell "every member" from
		 * "the first member" apart. */
		const picked = pickFieldForOp(ctx, "in", 2) ?? pickFieldForOp(ctx, "in", 1)
		if (picked === null || !canUseOp(ctx, picked.field, "nin")) return cannot()
		/* A picked field holds at least one value, so the list is never empty. */
		const members = picked.values.slice(0, 2).map(asTermValue)
		const conventions = conv(ctx)
		const field = picked.field.field
		const inTerm = filterTerm(conventions, { field, op: "in", value: members })
		const ninTerm = filterTerm(conventions, { field, op: "nin", value: members })
		if (inTerm === null || ninTerm === null) return cannot("a filter grammar that can express in and nin")
		return ready({ field, inTerm, members, ninTerm })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.in-is-union-of-eq"],
	id: "filter.nin-complements-in",
	lists: true,
	needs: "a field that allows both `in` and `nin`",
	subjects: subjectsOf.list,
	async run(ctx, { field, inTerm, ninTerm }): Promise<Outcome> {
		const judgeNin = (all: SetRead, inside: SetRead, outside: SetRead) => {
			const inIds = setOf(inside.items, ctx.identity)
			const ninIds = setOf(outside.items, ctx.identity)
			const overlap = [...inIds].filter((id) => ninIds.has(id))
			const union = new Set([...inIds, ...ninIds])
			const missing = ids(all.items, ctx.identity).filter((id) => {
				const record = ctx.records.find((row) => idOf(row, ctx.identity) === id)
				return record !== undefined && record[field] !== null && record[field] !== undefined && !union.has(id)
			})
			return { missing, overlap }
		}
		const reads = await readSettled(ctx, [{}, inTerm, ninTerm], (sets) => {
			const [a, i, o] = sets as [SetRead, SetRead, SetRead]
			const verdict = judgeNin(a, i, o)
			return verdict.overlap.length === 0 && verdict.missing.length === 0
		})
		if (reads === "rejected")
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the listings needed for nin() was rejected")
		if (reads === "incomplete") {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		if (reads === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_COLLECTION)
		/* One read per term, in the order the terms were given. */
		const [all, inside, outside] = reads as [SetRead, SetRead, SetRead]
		const inIds = setOf(inside.items, ctx.identity)
		const ninIds = setOf(outside.items, ctx.identity)
		const overlap = [...inIds].filter((id) => ninIds.has(id))
		if (overlap.length > 0) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "in() and nin() both match the same record",
				detail: `${overlap.length} record(s) appear in both ${field}.in and .nin.`,
				evidence: [inside.last.exchange, outside.last.exchange],
			})
		}
		const expected = ids(all.items, ctx.identity).filter((id) => {
			const record = ctx.records.find((row) => idOf(row, ctx.identity) === id)
			return record !== undefined && record[field] !== null && record[field] !== undefined
		})
		const union = new Set([...inIds, ...ninIds])
		const missing = expected.filter((id) => !union.has(id))
		if (missing.length === 0) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "in() and nin() do not cover the non-null set",
			detail: `${missing.length} non-null record(s) match neither side.`,
			evidence: [all.last.exchange, inside.last.exchange, outside.last.exchange],
		})
	},
})
