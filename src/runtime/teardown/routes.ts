/**
 * The routes teardown removes and reads records by, and what the run already deleted.
 */

import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { parseRouteRef } from "../../spec/routes.ts"
import type { Exchange } from "../exchange.ts"
import { fillPath } from "../fill-path.ts"
import type { Disposable } from "./types.ts"

/** A record as each principal holds it: two tenants may each have their own `row 1`. */
export function recordKey(entity: string, id: string, principal: string): string {
	return `${entity}\u0000${id}\u0000${principal}`
}

export function keyOf(item: Disposable): string {
	return recordKey(item.entity, item.id, item.owner.id)
}

/** Path segments, decoded, without empty ones. */
function segmentsOf(pathname: string): string[] {
	return pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			try {
				return decodeURIComponent(segment)
			} catch {
				return segment
			}
		})
}

/**
 * Whether a path, or an ancestor of it, was removed by a 2xx delete earlier in the run — compared
 * by segments, so `/tables/1` is never `/tables/11`. Earlier paths carry the base path; the path
 * asked about does not.
 */
export function deletedEarlierIn(transcript: readonly Exchange[]): (path: string) => boolean {
	const earlierDeletes = new Set(
		transcript
			.filter((exchange) => exchange.method === "DELETE" && exchange.status >= 200 && exchange.status < 300)
			.map((exchange) => new URL(exchange.url).pathname),
	)
	const earlierSegments = [...earlierDeletes].map(segmentsOf)
	return (path) => {
		const target = segmentsOf(path.split("?")[0] as string)
		return earlierSegments.some((done) => {
			for (let k = target.length; k >= 1; k--) {
				if (done.length >= k && done.slice(-k).every((segment, at) => segment === target[at])) return true
			}
			return false
		})
	}
}

/** The record's own read path, or `null` when its entity has no read it can fill. */
export function readPathOf(model: SpecModel, item: Disposable): { op: OperationModel; path: string } | null {
	const readId = model.entities.get(item.entity)?.read
	const op = readId === undefined ? undefined : model.byOperationId.get(readId)
	const param = op?.pathParams.at(-1)
	if (op === undefined || param === undefined) return null
	try {
		return { op, path: fillPath(op.path, { ...item.scope, [param]: item.id }) }
	} catch {
		return null
	}
}

/**
 * The operation that removes an instance: the entity's own delete, or an explicit `x-cleanup`
 * route for entities whose removal lives somewhere the graph does not connect.
 */
export function deleteOperationFor(entityName: string, model: SpecModel): OperationModel | null {
	const entity = model.entities.get(entityName)
	/* An entity's delete is one of the model's operations. */
	if (entity?.delete !== undefined) return model.byOperationId.get(entity.delete) as OperationModel

	for (const op of model.operations) {
		if (op.entity !== entityName || op.cleanup === null) continue
		const parsed = parseRouteRef(op.cleanup)
		if (parsed === null) continue
		const target = model.byRoute.get(`${parsed.method} ${parsed.path}`)
		if (target !== undefined) return target
	}
	return null
}
