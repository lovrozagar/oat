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

/**
 * An action on an existing row (`POST /tables/{table_id}/columns`) is not a create.
 * The entity scope only has parent ids. Bind the seeded row's id when the path still needs it.
 */
export function bindInstanceScope(
	model: SpecModel,
	entityName: string,
	identity: string,
	records: readonly Record<string, unknown>[],
	scope: Record<string, string>,
): Record<string, string> {
	const param = identityPathParam(model, entityName)
	if (scope[param] !== undefined) return { ...scope }
	for (const record of records) {
		const id = scalarId(record[identity]) ?? scalarId(record.id) ?? scalarId(record[param])
		if (id === undefined) continue
		return { ...scope, [param]: id }
	}
	return { ...scope }
}

/** `x-bind` strings: a literal, `$.…` on the seeded record, or `before:$.…` on the prelude body. */
export interface ActionBind {
	path: Record<string, string>
	body: Record<string, string>
	query: Record<string, string>
}

export function readActionBind(value: unknown): ActionBind | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null
	const rec = value as Record<string, unknown>
	return { path: bindStrings(rec.path), body: bindStrings(rec.body), query: bindStrings(rec.query) }
}

export function readBefore(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined
}

function bindStrings(value: unknown): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
	const out: Record<string, string> = {}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item !== "") out[key] = item
	}
	return out
}

/** `$.a.b[0].c` and `$.a[*].c`. A `*` step returns every match; otherwise the first. */
export function valueAt(root: unknown, pointer: string): unknown {
	if (!pointer.startsWith("$")) return undefined
	const parts = pointerTokens(pointer)
	let current: unknown[] = [root]
	for (const part of parts) {
		const next: unknown[] = []
		for (const node of current) {
			if (part === "*") {
				if (Array.isArray(node)) next.push(...node)
				continue
			}
			if (node === null || typeof node !== "object") continue
			if (typeof part === "number") {
				if (Array.isArray(node)) next.push(node[part])
				continue
			}
			next.push((node as Record<string, unknown>)[part])
		}
		current = next
	}
	if (parts.includes("*")) return current.filter((item) => item !== undefined)
	return current[0]
}

function pointerTokens(pointer: string): Array<string | number | "*"> {
	const body = pointer.startsWith("$.") ? pointer.slice(2) : pointer.slice(1)
	const tokens: Array<string | number | "*"> = []
	const re = /([^[\].]+)|\[(\*|\d+)\]/g
	for (let match = re.exec(body); match !== null; match = re.exec(body)) {
		if (match[1] !== undefined) tokens.push(match[1])
		else if (match[2] === "*") tokens.push("*")
		else tokens.push(Number(match[2]))
	}
	return tokens
}

function resolveBindExpr(expr: string, records: readonly Record<string, unknown>[], beforeBody: unknown): unknown {
	if (expr.startsWith("before:")) return valueAt(beforeBody, expr.slice("before:".length))
	if (!expr.startsWith("$")) return expr
	for (const record of records) {
		const value = valueAt(record, expr)
		if (value !== undefined) return value
	}
	return undefined
}

/**
 * First id under a key that names this path param. `col_id` reads `columns_json[0].id`
 * when the record has no literal `col_id`.
 */
export function nestedParamId(record: Record<string, unknown>, param: string): string | undefined {
	const direct = findCreatedId(record, [param])
	if (direct !== undefined) return direct
	if (!param.endsWith("_id")) return undefined
	return stemArrayId(record, param.slice(0, -"_id".length), 0)
}

function stemArrayId(value: unknown, stem: string, depth: number): string | undefined {
	if (stem === "" || depth > 6 || value === null || typeof value !== "object") return undefined
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = stemArrayId(item, stem, depth + 1)
			if (found !== undefined) return found
		}
		return undefined
	}
	for (const [key, child] of Object.entries(value)) {
		const bare = key.replace(/_json$/, "")
		if ((bare === stem || bare === `${stem}s` || bare.startsWith(stem)) && Array.isArray(child)) {
			for (const item of child) {
				if (item === null || typeof item !== "object" || Array.isArray(item)) continue
				const id = scalarId((item as Record<string, unknown>).id)
				if (id !== undefined) return id
			}
		}
		const deeper = stemArrayId(child, stem, depth + 1)
		if (deeper !== undefined) return deeper
	}
	return undefined
}

/** Fill path params still missing after the instance id bind. Explicit `x-bind.path` wins over the stem walk. */
export function bindActionScope(
	pathParams: readonly string[],
	records: readonly Record<string, unknown>[],
	scope: Record<string, string>,
	bind: ActionBind | null,
	beforeBody: unknown,
): Record<string, string> {
	const next = { ...scope }
	for (const param of pathParams) {
		const expr = bind?.path[param]
		if (expr !== undefined) {
			const value = resolveBindExpr(expr, records, beforeBody)
			const id = scalarId(value) ?? (Array.isArray(value) ? scalarId(value[0]) : undefined)
			if (id !== undefined) {
				next[param] = id
				continue
			}
		}
		if (next[param] !== undefined) continue
		for (const record of records) {
			const id = nestedParamId(record, param)
			if (id === undefined) continue
			next[param] = id
			break
		}
	}
	return next
}

/** Overlay `x-bind` body fields and query values. Literals pass through; pointers read the record or prelude. */
export function applyActionBind(
	bind: ActionBind | null,
	records: readonly Record<string, unknown>[],
	beforeBody: unknown,
	body: Record<string, unknown> | undefined,
): { body: Record<string, unknown> | undefined; query: Record<string, string> } {
	const query: Record<string, string> = {}
	if (bind === null) return { body, query }
	const next = body === undefined ? undefined : { ...body }
	for (const [field, expr] of Object.entries(bind.body)) {
		if (next === undefined) break
		const value = resolveBindExpr(expr, records, beforeBody)
		if (value !== undefined) next[field] = value
	}
	for (const [field, expr] of Object.entries(bind.query)) {
		const value = resolveBindExpr(expr, records, beforeBody)
		if (typeof value === "string" && value !== "") query[field] = value
		else if (typeof value === "number" && Number.isFinite(value)) query[field] = String(value)
		else if (Array.isArray(value)) {
			const joined = value.filter((item): item is string => typeof item === "string" && item !== "").join(",")
			if (joined !== "") query[field] = joined
		}
	}
	return { body: next, query }
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
