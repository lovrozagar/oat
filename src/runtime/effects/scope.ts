/**
 * Parent-id binding for `x-effects` / `x-wait`.
 *
 * A write that creates A (a table) and appends children (rows) has no `table_id` in the write
 * path. Later effects — and `x-wait` — fill the child list with the id from the write response
 * or from A's list delta.
 */

import type { EffectSpec } from "../../spec/extensions/effects.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { fillPath } from "../fill-path.ts"
import { createdIdKeys, findCreatedId, scalarId } from "./ids.ts"

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
/** What shows a created record's id: the write's response body, and the ids its list gained. */
export interface CreatedEvidence {
	body: unknown
	added?: readonly string[]
}

export function bindCreatedScope(
	model: SpecModel,
	entityName: string,
	{ body: writeBody, added: addedIds = [] }: CreatedEvidence,
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

/** The seeded instance an action acts on: its entity, identity field, records and scope. */
export interface InstanceScopeInput {
	model: SpecModel
	entityName: string
	identity: string
	records: readonly Record<string, unknown>[]
	scope: Record<string, string>
}

/**
 * An action on an existing row (`POST /tables/{table_id}/columns`) is not a create.
 * The entity scope only has parent ids. Bind the seeded row's id when the path still needs it.
 */
export function bindInstanceScope(input: InstanceScopeInput): Record<string, string> {
	const { identity, records, scope } = input
	const param = identityPathParam(input.model, input.entityName)
	if (scope[param] !== undefined) return { ...scope }
	for (const record of records) {
		const id = scalarId(record[identity]) ?? scalarId(record.id) ?? scalarId(record[param])
		if (id === undefined) continue
		return { ...scope, [param]: id }
	}
	return { ...scope }
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

/** What shows the ids a write's create effects made: its response body, and the ids each entity's list gained. */
export interface EffectsEvidence {
	body: unknown
	deltas?: ReadonlyMap<string, readonly string[]>
}

export function bindAfterCreateEffects(
	model: SpecModel,
	effects: readonly EffectSpec[],
	{ body, deltas = new Map() }: EffectsEvidence,
): Record<string, string> {
	const bound: Record<string, string> = {}
	for (const effect of effects) {
		if (effect.op !== "create") continue
		Object.assign(bound, bindCreatedScope(model, effect.entity, { added: deltas.get(effect.entity) ?? [], body }))
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
