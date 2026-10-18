/** What one declared field allows: its operators, closed or implicit, its aliases, and its nulls placements. */

import type { FilterOp, Nulls } from "../../config/types/query.ts"
import type { EffectiveFilterField, EffectiveQueryCapabilities, EffectiveSortableField } from "./effective.ts"
import { IMPLICIT_OPS, isFilterOp } from "./ops.ts"

export function opsForField(field: EffectiveFilterField, caps: EffectiveQueryCapabilities): FilterOp[] {
	if (field.ops !== undefined) return field.ops
	if (field.type !== undefined) {
		const byType = caps.operatorsByType?.[field.type]
		if (byType !== undefined) return byType
	}
	if (caps.operators !== undefined) return caps.operators
	return [...IMPLICIT_OPS]
}

export function opsAreClosed(field: EffectiveFilterField, caps: EffectiveQueryCapabilities): boolean {
	return (
		field.ops !== undefined ||
		(field.type !== undefined && caps.operatorsByType?.[field.type] !== undefined) ||
		caps.operators !== undefined
	)
}

/** The field allows `op` itself, or an alias the capabilities map onto `op`. */
export function fieldAllows(field: EffectiveFilterField, op: FilterOp, caps: EffectiveQueryCapabilities): boolean {
	const ops = opsForField(field, caps)
	if (ops.includes(op)) return true
	for (const alias of Object.keys(caps.aliases)) {
		if (caps.aliases[alias as FilterOp] === op && isFilterOp(alias) && ops.includes(alias)) return true
	}
	return false
}

export function anyFieldAllows(caps: EffectiveQueryCapabilities, op: FilterOp): EffectiveFilterField | undefined {
	return caps.filterable.find((field) => fieldAllows(field, op, caps))
}

export function fieldAllowsNulls(
	field: EffectiveSortableField,
	caps: EffectiveQueryCapabilities,
	token: Nulls,
): boolean {
	if (field.nulls?.includes(token) === true) return true
	return caps.sort?.nulls?.includes(token) === true
}
