/**
 * `x-entity.identity: self` — the signed-up caller is the record.
 * There is no list. A create, when the spec has one, runs before the read and the read
 * must show a value from that create. An update is still there on the next read.
 * No token is a 401.
 */

import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import type { CheckId } from "../check-ids.ts"

export const SELF_IDENTITY = "self"
export const SELF_CHECK_ID = "auth.self-is-the-caller" as const satisfies CheckId

export function selfReadIds(entity: EntityModel): string[] {
	if (entity.reads !== undefined && entity.reads.length > 0) return entity.reads
	return entity.read === undefined ? [] : [entity.read]
}

/** GET actions with no path id, such as a handle query on the caller. */
export function selfActionIds(entity: EntityModel, model: SpecModel): string[] {
	if (entity.identity !== SELF_IDENTITY) return []
	return entity.actions.filter((id) => {
		const op = model.byOperationId.get(id)
		return op !== undefined && op.method.toUpperCase() === "GET" && op.pathParams.length === 0
	})
}

export function selfOperationIds(entity: EntityModel, model?: SpecModel): string[] {
	if (entity.identity !== SELF_IDENTITY) return []
	const ids = [...selfReadIds(entity), entity.update].filter((id): id is string => id !== undefined)
	const actions = model === undefined ? [] : selfActionIds(entity, model)
	const withCreate = ids.length === 0 || entity.create === undefined ? ids : [entity.create, ...ids]
	return [...withCreate, ...actions]
}

export function entityIsSelf(entity: EntityModel): boolean {
	return selfOperationIds(entity).length > 0
}
