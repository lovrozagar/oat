import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, conv, filterable, FOUNDATIONS, MOVING_FILTER } from "../../query/capabilities.ts"
import { readSettled, sameSet, setOf } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import type { SetRead } from "../../sets/read.ts"
import { pickFieldForOp } from "./fields.ts"

export const filterInIsUnionOfEq = defineCheck<{
	field: string
	a: unknown
	b: unknown
	inTerm: Record<string, string>
	eqA: Record<string, string>
	eqB: Record<string, string>
}>({
	plan: (ctx) => {
		const picked = filterable(ctx) ? pickFieldForOp(ctx, "in", 2) : null
		const [a, b] = picked?.values ?? []
		if (picked === null || a === undefined || b === undefined) return cannot()
		const conventions = conv(ctx)
		const field = picked.field.field
		const inTerm = filterTerm(conventions, field, "in", [asTermValue(a), asTermValue(b)])
		const eqA = filterTerm(conventions, field, "eq", asTermValue(a))
		const eqB = filterTerm(conventions, field, "eq", asTermValue(b))
		if (inTerm === null || eqA === null || eqB === null) return cannot("a filter grammar that can express in and eq")
		return ready({ a, b, eqA, eqB, field, inTerm })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.equality-selects-exactly-one"],
	id: "filter.in-is-union-of-eq",
	needs: "a field that allows `in` and at least two distinct values",
	subjects: subjectsOf.list,
	async run(ctx, { a, b, eqA, eqB, field, inTerm }): Promise<Outcome> {
		const union = (left: SetRead, right: SetRead): Set<string> =>
			new Set([...ids(left.items, ctx.identity), ...ids(right.items, ctx.identity)])
		const reads = await readSettled(ctx, [inTerm, eqA, eqB], (sets) => {
			const [inRead, eqARead, eqBRead] = sets as [SetRead, SetRead, SetRead]
			return sameSet(union(eqARead, eqBRead), setOf(inRead.items, ctx.identity))
		})
		if (reads === "rejected")
			return ctx.findings.unresolved(this.id, ctx.entityName, "one of the listings needed for in() was rejected")
		if (reads === "incomplete") {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		if (reads === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_FILTER)
		/* One read per term, in the order the terms were given. */
		const [together, onlyA, onlyB] = reads as [SetRead, SetRead, SetRead]
		const expected = union(onlyA, onlyB)
		const got = setOf(together.items, ctx.identity)
		if (sameSet(expected, got)) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"in() is not the union of the equalities it lists",
			`${field}.in.(${String(a)},${String(b)}) returned ${got.size} record(s); ` +
				`eq on each value together match ${expected.size}.`,
			[together.last.exchange, onlyA.last.exchange, onlyB.last.exchange],
		)
	},
})
