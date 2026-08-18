/**
 * Cardinality holds and parent-id binding for `x-effects` / `x-wait`.
 *
 * A write that creates A (a table) and appends children (rows) has no `table_id` in the write
 * path. Later effects — and `x-wait` — fill the child list with the id from the write response
 * or from A's list delta. `count` is exact; `min` is at-least.
 */

import type { EffectSpec } from "../spec/extensions.ts"
import type { SpecModel } from "../spec/graph.ts"
import { fillPath } from "./world.ts"

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
export function effectHolds(effect: EffectSpec, delta: number, added: number, removed: number): boolean {
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

export function scalarId(value: unknown): string | undefined {
	if (typeof value === "string" && value !== "") return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	return undefined
}

/** Conventional `{entity}_id`, then the entity identity, then `id`. */
export function createdIdKeys(entity: string, identity: string | null): string[] {
	const keys = [`${entity}_id`]
	if (identity !== null && identity !== "" && !keys.includes(identity)) keys.push(identity)
	if (!keys.includes("id")) keys.push("id")
	return keys
}

/** Walks objects / arrays a few levels for a conventional id field. */
export function findCreatedId(body: unknown, keys: readonly string[], depth = 0): string | undefined {
	if (body === null || typeof body !== "object" || depth > 3) return undefined
	if (Array.isArray(body)) {
		for (const item of body) {
			const found = findCreatedId(item, keys, depth + 1)
			if (found !== undefined) return found
		}
		return undefined
	}
	const rec = body as Record<string, unknown>
	for (const key of keys) {
		const id = scalarId(rec[key])
		if (id !== undefined) return id
	}
	for (const value of Object.values(rec)) {
		const found = findCreatedId(value, keys, depth + 1)
		if (found !== undefined) return found
	}
	return undefined
}

/** Path parameter that names an instance of this entity (`table` → `table_id`). */
export function identityPathParam(model: SpecModel, entityName: string): string {
	const conventional = `${entityName}_id`
	const entity = model.entities.get(entityName)
	if (entity === undefined) return conventional
	for (const opId of [entity.read, entity.delete, entity.update]) {
		if (opId === undefined) continue
		const last = model.byOperationId.get(opId)?.pathParams.at(-1)
		if (last) return last
	}
	return conventional
}

/**
 * Bind the created A id so a later child list can `fillPath`. Prefers the write body, then the
 * first id added to A's list (same adopt idea as a 402 plan-limit reuse).
 */
export function bindCreatedScope(
	model: SpecModel,
	entityName: string,
	writeBody: unknown,
	addedIds: readonly string[] = [],
): Record<string, string> {
	const identity = model.entities.get(entityName)?.identity ?? "id"
	const param = identityPathParam(model, entityName)
	const id = findCreatedId(writeBody, createdIdKeys(entityName, identity)) ?? addedIds[0]
	if (id === undefined) return {}
	const bound: Record<string, string> = { [param]: id }
	const conventional = `${entityName}_id`
	if (param !== conventional) bound[conventional] = id
	return bound
}

/** Fill poll-path params the write scope does not have, from the write body. */
export function bindMissingPathParams(
	pathParams: readonly string[],
	scope: Record<string, string>,
	writeBody: unknown,
): Record<string, string> {
	const bound: Record<string, string> = {}
	for (const param of pathParams) {
		if (scope[param] !== undefined || bound[param] !== undefined) continue
		const id = findCreatedId(writeBody, [param])
		if (id !== undefined) bound[param] = id
	}
	return bound
}

export function bindAfterCreateEffects(
	model: SpecModel,
	effects: readonly EffectSpec[],
	writeBody: unknown,
	deltas: ReadonlyMap<string, readonly string[]> = new Map(),
): Record<string, string> {
	const bound: Record<string, string> = {}
	for (const effect of effects) {
		if (effect.op !== "create") continue
		Object.assign(bound, bindCreatedScope(model, effect.entity, writeBody, deltas.get(effect.entity) ?? []))
	}
	return bound
}

export function mergeScope(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
	return { ...base, ...extra }
}

export function canFillPath(template: string, values: Record<string, string>): boolean {
	try {
		fillPath(template, values)
		return true
	} catch {
		return false
	}
}
