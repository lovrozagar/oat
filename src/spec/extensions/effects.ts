/** `x-effects`: the records an operation adds, changes or removes, and how many. */

import type { OperationObject } from "../types.ts"
import type { GapCollector } from "./gaps.ts"
import { ext } from "./tag.ts"

export interface EffectSpec {
	entity: string
	op: "create" | "append" | "update" | "delete" | "replace"
	/** Exact cardinality delta. Default `1` when both `count` and `min` are omitted. */
	count?: number
	/** At-least cardinality (`delta >= min` and `added.length >= min`). Mutually exclusive with `count`. */
	min?: number
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export function readEffects(op: OperationObject, operationId?: string, gaps?: GapCollector): EffectSpec[] {
	const raw = ext<unknown>(op, "x-effects")
	if (!Array.isArray(raw)) return []
	const out: EffectSpec[] = []
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue
		const rec = item as Record<string, unknown>
		if (typeof rec.entity !== "string" || typeof rec.op !== "string") continue
		const effect: EffectSpec = { entity: rec.entity, op: rec.op as EffectSpec["op"] }
		if (finite(rec.count)) effect.count = rec.count
		if (finite(rec.min)) effect.min = rec.min
		if (effect.count !== undefined && effect.min !== undefined) {
			gaps?.record(
				operationId ?? "",
				"x-effects",
				`item for "${effect.entity}" sets both count and min; use exactly one`,
			)
			continue
		}
		out.push(effect)
	}
	return out
}
