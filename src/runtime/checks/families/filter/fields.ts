import { canWriteFilterOp } from "../../../../spec/conventions/filter.ts"
import type { EffectiveFilterField } from "../../../../spec/query/effective.ts"
import { fieldAllows } from "../../../../spec/query/field-ops.ts"
import { FILTER_OPS, ORDERED_TYPES } from "../../../../spec/query/ops.ts"
import type { Record_ } from "../../../world.ts"
import type { CheckContext } from "../../core/context.ts"
import { canUseOp, conv, resolvedCaps } from "../../query/capabilities.ts"
import { cohortFact, setOf } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"

export function fieldsAllowing(ctx: CheckContext, op: (typeof FILTER_OPS)[number]): EffectiveFilterField[] {
	if (!canWriteFilterOp(conv(ctx), op)) return []
	return resolvedCaps(ctx).filterable.filter((field) => fieldAllows(field, op, resolvedCaps(ctx)))
}

function distinctValues(records: Record_[], field: string): unknown[] {
	const seen = new Set<string>()
	const out: unknown[] = []
	for (const record of records) {
		const value = record[field]
		if (value === null || value === undefined) continue
		const key = String(value)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(value)
	}
	return out
}

/** List identities that oat seeded. Extra rows outside this set are not scored as defects. */
export function knownHits(items: Record_[], ctx: CheckContext): Set<string> {
	const known = setOf(ctx.records, ctx.identity)
	return new Set(ids(items, ctx.identity).filter((id) => known.has(id)))
}

export function pickFieldForOp(
	ctx: CheckContext,
	op: (typeof FILTER_OPS)[number],
	minDistinct = 2,
): { field: EffectiveFilterField; values: unknown[] } | null {
	for (const field of fieldsAllowing(ctx, op)) {
		const values = distinctValues(ctx.records, field.field)
		if (values.length >= minDistinct) return { field, values }
	}
	return null
}

export function pickOrderedField(ctx: CheckContext): { field: EffectiveFilterField; values: number[] } | null {
	return cohortFact(ctx, "ordered", () => computePickOrderedField(ctx))
}

function computePickOrderedField(ctx: CheckContext): { field: EffectiveFilterField; values: number[] } | null {
	const caps = resolvedCaps(ctx)
	for (const field of caps.filterable) {
		if (field.type !== undefined && !ORDERED_TYPES.has(field.type)) continue
		if (!canUseOp(ctx, field, "gt") || !canUseOp(ctx, field, "lt") || !canUseOp(ctx, field, "eq")) continue
		const values = ctx.records.map((r) => r[field.field]).filter((v): v is number => typeof v === "number")
		if (values.length < 3) continue
		return { field, values }
	}
	return null
}
