/**
 * Cardinality holds for `x-effects` / `x-wait`. `count` is exact; `min` is at-least.
 */

import type { EffectSpec } from "../../spec/extensions/effects.ts"

export type EffectCardinality = { mode: "exact"; count: number } | { mode: "min"; min: number }

/** `min` wins when present. Default remains exact `count: 1` when both are omitted. */
export function effectCardinality(effect: EffectSpec): EffectCardinality {
	if (typeof effect.min === "number") return { min: effect.min, mode: "min" }
	return { count: effect.count ?? 1, mode: "exact" }
}

export function describeEffectHold(effect: EffectSpec): string {
	const hold = effectCardinality(effect)
	return hold.mode === "min" ? `${effect.op} ≥ ${hold.min}` : `${effect.op} × ${hold.count}`
}

/**
 * `create`/`append`: exact `delta === n && added === n`, or at-least `delta >= n && added >= n`.
 * `delete`: the same against removals (delta is negative).
 * `update`/`replace`: the collection must not change size.
 */
/** How a collection changed across an action: its size delta, and the ids it gained and lost. */
export interface CollectionChange {
	delta: number
	added: number
	removed: number
}

export function effectHolds(effect: EffectSpec, { delta, added, removed }: CollectionChange): boolean {
	const hold = effectCardinality(effect)
	if (effect.op === "create" || effect.op === "append") {
		return hold.mode === "exact" ? delta === hold.count && added === hold.count : delta >= hold.min && added >= hold.min
	}
	if (effect.op === "delete") {
		return hold.mode === "exact"
			? delta === -hold.count && removed === hold.count
			: delta <= -hold.min && removed >= hold.min
	}
	return delta === 0
}
