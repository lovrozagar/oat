/** Path parameters nothing in the document can produce, and the entity each parameter identifies. */

import { singularise } from "../extensions/entity.ts"
import { isParamSegment, pathShape, segmentsOf } from "./segments.ts"
import type { EntityModel, OperationModel } from "./types.ts"

/**
 * A path parameter is a root when nothing in the document can produce it: no entity whose name
 * matches has a create operation. Roots must be supplied by config before a run starts —
 * discovering them late is what turns one missing fixture into a cascade of failures.
 */
export function collectRoots(
	operations: readonly OperationModel[],
	entities: ReadonlyMap<string, EntityModel>,
): string[] {
	const roots = new Set<string>()
	for (const op of operations) {
		for (const param of op.rootParams) roots.add(param)
	}
	for (const op of operations) {
		for (const param of op.pathParams) {
			/* Resolve the entity from the segment the parameter qualifies, not from its name:
			 * `/table-templates/{template_id}` identifies a `table-template`, and matching on
			 * the name alone would invent a phantom `template` root. */
			const implied = owningEntityOf(operations, op.path, param) ?? impliedEntityName(param)
			if (implied === null) continue
			const entity = entities.get(implied)
			if (entity === undefined || (entity.create === undefined && entity.invite === null)) roots.add(param)
		}
	}
	return [...roots].sort()
}

/**
 * The entity `{param}` identifies: whatever the document tags the collection before it as — its
 * create, else its item read. Names can carry a parent (`organization-webhook`, when another
 * `webhooks` collection exists), so the segment alone does not name it. Falls back to the
 * segment's singular when no route sits on that collection.
 */
export function owningEntityOf(
	operations: readonly Pick<OperationModel, "entity" | "method" | "path">[],
	path: string,
	param: string,
): string | null {
	const segments = segmentsOf(path)
	const index = segments.indexOf(`{${param}}`)
	if (index <= 0) return null
	const collection = pathShape(segments.slice(0, index).join("/"))
	const item = pathShape(segments.slice(0, index + 1).join("/"))
	const tagged = (method: string, at: string) =>
		operations.find((op) => op.entity !== null && op.method === method && pathShape(op.path) === at)?.entity
	return tagged("POST", collection) ?? tagged("GET", item) ?? owningEntityName(path, param)
}

/** The collection segment immediately preceding `{param}` in the path. */
export function owningEntityName(path: string, param: string): string | null {
	const segments = segmentsOf(path)
	const index = segments.indexOf(`{${param}}`)
	if (index <= 0) return null
	const previous = segments[index - 1] as string
	if (isParamSegment(previous)) return null
	return singularise(previous)
}

/** `{project_id}` → `project`, `{tableId}` → `table`. */
export function impliedEntityName(param: string): string | null {
	const stripped = param
		.replace(/[_.]?(id|slug|uuid|key)$/i, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
	return stripped.length === 0 ? null : stripped.replace(/_/g, "-")
}

/** What a prefix root is read from: the operations, and the entities whose list and create they are. */
export type Scoping = { operations: readonly OperationModel[]; entities: ReadonlyMap<string, EntityModel> }

/**
 * The path parameters `op` hangs below: tagged `x-root`, or followed by another parameter, or by the
 * collection its entity lists or creates in. An id a route ends on, or acts on (`/invites/{token}/accept`), is none.
 */
export function scopingParams(op: OperationModel, model: Scoping): string[] {
	const segments = segmentsOf(op.path)
	const entity = op.entity === null ? undefined : model.entities.get(op.entity)
	const collects = entity !== undefined && (entity.list === op.operationId || entity.create === op.operationId)
	return op.pathParams.filter((param) => {
		if (op.rootParams.includes(param)) return true
		const after = segments.slice(segments.indexOf(`{${param}}`) + 1)
		return after.some((segment) => segment.startsWith("{")) || (collects && after.length > 0)
	})
}

/** The prefix roots a document's routes hang below, each with the operations it scopes. */
export function prefixRoots(model: Scoping): Map<string, string[]> {
	const scoped = new Map<string, string[]>()
	for (const op of model.operations) {
		for (const root of scopingParams(op, model)) scoped.set(root, [...(scoped.get(root) ?? []), op.operationId])
	}
	return scoped
}
