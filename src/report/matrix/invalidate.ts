/**
 * The document's `x-invalidate` claims as links between entities: a write on one entity declared to
 * change a read route, and the entity that route belongs to.
 */

import type { InvalidateLink, MatrixModel } from "./types.ts"

export function invalidateLinks(model: MatrixModel): InvalidateLink[] {
	const out: InvalidateLink[] = []
	for (const op of model.operations) {
		if (op.entity === null) continue
		for (const route of op.invalidates) {
			const toEntity = model.byRoute.get(route)?.entity ?? owningEntityFromRoute(route, model) ?? op.entity
			out.push({
				cross: toEntity !== op.entity,
				fromEntity: op.entity,
				fromOp: op.operationId,
				toEntity,
				toRoute: route,
			})
		}
	}
	return out
}

function owningEntityFromRoute(route: string, model: MatrixModel): string | null {
	for (const entity of model.entities.values()) {
		if (entity.readSurface.includes(route)) return entity.name
	}
	return null
}
