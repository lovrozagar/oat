import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { Listed } from "../../core/context.ts"
import { cannot, type Plan, ready } from "../../core/plan.ts"
import { canUseOp, conv, MOVING_FILTER } from "../../query/capabilities.ts"
import { readSettled, sameSet, setOf } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import type { SetRead } from "../../sets/read.ts"
import { pickOrderedField } from "./fields.ts"

/** A closed range, its open half, and equality, on one ordered field at one threshold. */
export interface RangeProbe {
	field: string
	closed: "gte" | "lte"
	open: "gt" | "lt"
	threshold: number
	closedTerm: Record<string, string>
	openTerm: Record<string, string>
	eqTerm: Record<string, string>
}

export function rangePlan(ctx: Listed, closed: "gte" | "lte", open: "gt" | "lt"): Plan<RangeProbe> {
	const picked = pickOrderedField(ctx)
	if (picked === null) return cannot()
	if (!canUseOp(ctx, picked.field, closed)) return cannot(`an ordered field that allows \`${closed}\``)
	const threshold = [...new Set(picked.values)].sort((a, b) => a - b)[Math.floor(picked.values.length / 3)]
	if (threshold === undefined) return cannot()
	const field = picked.field.field
	const conventions = conv(ctx)
	const closedTerm = filterTerm(conventions, { field, op: closed, value: threshold })
	const openTerm = filterTerm(conventions, { field, op: open, value: threshold })
	const eqTerm = filterTerm(conventions, { field, op: "eq", value: threshold })
	if (closedTerm === null || openTerm === null || eqTerm === null) {
		return cannot(`a filter grammar that can express ${closed}, ${open} and eq`)
	}
	return ready({ closed, closedTerm, eqTerm, field, open, openTerm, threshold })
}

export async function assertRangeUnion(
	ctx: Listed,
	check: string,
	{ closed, closedTerm, eqTerm, field, open, openTerm, threshold }: RangeProbe,
): Promise<Outcome> {
	/* One read per term, in the order the terms were given. */
	const union = (sets: SetRead[]) => {
		const [closedSet, openSet, eqSet] = sets as [SetRead, SetRead, SetRead]
		return {
			expected: new Set([...ids(openSet.items, ctx.identity), ...ids(eqSet.items, ctx.identity)]),
			got: setOf(closedSet.items, ctx.identity),
		}
	}
	const reads = await readSettled(ctx, [closedTerm, openTerm, eqTerm], (sets) => {
		const { expected, got } = union(sets)
		return sameSet(expected, got)
	})
	if (reads === "rejected")
		return ctx.findings.unresolved(check, ctx.entityName, "one of the range listings was rejected")
	if (reads === "incomplete") {
		return ctx.findings.unresolved(check, ctx.entityName, "the collection is larger than the walk covers")
	}
	if (reads === "moving") return ctx.findings.unresolved(check, ctx.entityName, MOVING_FILTER)
	const [closedSet, openSet, eqSet] = reads as [SetRead, SetRead, SetRead]
	const { expected, got } = union(reads)
	if (sameSet(expected, got)) return ASSERTED
	return ctx.findings.backend(check, ctx.entityName, {
		summary: `${closed} is not ${open} ∪ eq`,
		detail: `${field}.${closed}.${threshold} returned ${got.size}; ${open} ∪ eq is ${expected.size}.`,
		evidence: [closedSet.last.exchange, openSet.last.exchange, eqSet.last.exchange],
	})
}
