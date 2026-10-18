/**
 * Each entity's read surface — the routes through which an instance is observable — and whether
 * an instance can be tracked across them at all.
 *
 * The central move: `x-invalidate` is read as a graph edge, not a cache hint. Inverting it gives
 * each entity the set of projections through which it is observable: the criss-cross matrix.
 */

import type { GapCollector } from "../extensions/gaps.ts"
import { parseRouteRef } from "../routes.ts"
import { entityNamed } from "./entities.ts"
import type { EntityModel, OperationModel } from "./types.ts"

/** The document's operations, in order and by route. */
export interface DocumentOperations {
	operations: readonly OperationModel[]
	byRoute: ReadonlyMap<string, OperationModel>
}

/** Invert x-invalidate: a mutator's declared read routes belong to its entity's surface. */
export function invertInvalidate(
	entities: Map<string, EntityModel>,
	{ byRoute, operations }: DocumentOperations,
	gaps: GapCollector,
): void {
	for (const op of operations) {
		if (op.entity === null || op.invalidates.length === 0) continue
		const entity = entityNamed(entities, op.entity)
		for (const ref of op.invalidates) {
			if (parseRouteRef(ref)?.method !== "GET") continue
			if (!entity.readSurface.includes(ref)) {
				entity.readSurface.push(ref)
				entity.declaredSurface.push(ref)
			}
			if (!byRoute.has(ref)) {
				gaps.record(op.operationId, "x-invalidate", `names "${ref}", which is not an operation in this document`)
			}
		}
	}
}

/** Sibling fallback for entities whose mutators declared nothing. */
export function fallBackToSiblings(
	entities: ReadonlyMap<string, EntityModel>,
	operations: readonly OperationModel[],
	gaps: GapCollector,
): void {
	for (const entity of entities.values()) {
		if (entity.readSurface.length > 0) continue
		for (const opId of [entity.list, entity.read]) {
			if (opId === undefined) continue
			const op = operations.find((o) => o.operationId === opId)
			if (op !== undefined) entity.readSurface.push(op.route)
		}
		const mutator = entity.create ?? entity.update ?? entity.delete
		if (entity.readSurface.length > 0 && mutator) {
			gaps.record(
				mutator,
				"x-invalidate",
				`entity "${entity.name}" has mutators but no declared read surface; ` +
					`falling back to sibling routes ${entity.readSurface.join(", ")}`,
			)
		}
	}
}

/** An entity is trackable when it has an identity; one with mutators and none is a gap. */
export function markTrackable(entities: ReadonlyMap<string, EntityModel>, gaps: GapCollector): void {
	for (const entity of entities.values()) {
		entity.trackable = entity.identity !== null
		const mutator = entity.create ?? entity.update
		if (!entity.trackable && mutator !== undefined) {
			gaps.record(
				mutator,
				"x-entity.identity",
				`entity "${entity.name}" has no discoverable identity property, so instances cannot ` +
					"be tracked across projections; lifecycle and criss-cross coverage disabled",
			)
		}
	}
}
