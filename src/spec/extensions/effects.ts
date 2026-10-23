/** `x-effects`: the records an operation adds, changes or removes, and how many. */

import type { RawOf } from "../../config/types/raw.ts"
import { isObject } from "../tags/checks.ts"
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

const OPS: readonly EffectSpec["op"][] = ["create", "append", "update", "delete", "replace"]
const isOp = (value: string): value is EffectSpec["op"] => (OPS as readonly string[]).includes(value)

/* One item as an effect, or none: what is wrong with it goes to `report`. */
function effectOf(item: unknown, report: (detail: string) => void): EffectSpec | undefined {
	if (!isObject(item)) return undefined
	const rec: RawOf<EffectSpec> = item
	if (typeof rec.entity !== "string" || typeof rec.op !== "string") return undefined
	if (!isOp(rec.op)) {
		report(`item for "${rec.entity}" has op "${rec.op}"; use ${OPS.slice(0, -1).join(", ")} or ${OPS.at(-1)}`)
		return undefined
	}
	const effect: EffectSpec = { entity: rec.entity, op: rec.op }
	if (finite(rec.count)) effect.count = rec.count
	if (finite(rec.min)) effect.min = rec.min
	if (effect.count !== undefined && effect.min !== undefined) {
		report(`item for "${effect.entity}" sets both count and min; use exactly one`)
		return undefined
	}
	return effect
}

export function readEffects(op: OperationObject, operationId?: string, gaps?: GapCollector): EffectSpec[] {
	const raw = ext(op, "x-effects")
	if (!Array.isArray(raw)) return []
	const report = (detail: string): void => gaps?.record(operationId ?? "", "x-effects", detail)
	return raw.flatMap((item) => effectOf(item, report) ?? [])
}
