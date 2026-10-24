/**
 * The naming heuristic cannot tell a collection from a verb: `POST /tables/{id}/duplicate` and
 * `POST /tables` are the same shape. The document itself settles it — a noun names an entity
 * only if the API exposes an *item route* for it (`.../<noun>/{param}`), or if a GET on the
 * collection returns a collection-shaped body.
 *
 * Everything else is an action on the nearest enclosing entity. Without this pass a spec with
 * 5 entities models as 24, and every spurious one drags a full lifecycle plan behind it.
 */

import type { GapCollector } from "../extensions/gaps.ts"
import { singularize } from "../extensions/entity.ts"
import { isParamSegment, segmentsOf } from "./segments.ts"
import type { OperationModel } from "./types.ts"

/**
 * Whether the final segment reads as a verb rather than a noun — `/pet/findByStatus`,
 * `/reports/exportAll`, `/users/searchByEmail`.
 *
 * Such a segment names an operation, not a collection, even though it returns a collection. Left
 * alone it becomes an entity called "findbystatus", which is both untestable and noise in the
 * report.
 */
const VERB_PREFIX =
	/^(find|search|query|list|get|fetch|count|export|import|download|upload|bulk|batch|lookup|resolve|mine|me|all|current|latest|recent|active|archived|default|summary|stats?|statistics|history|preview)([A-Z_-]|$)/

/** Demotes operations that belong to no entity. Returns the collection-shaped views kept as their own entity. */
export function demoteNonEntities(operations: OperationModel[], gaps: GapCollector): OperationModel[] {
	const views: OperationModel[] = []
	const nouns = nounsWithItemRoute(operations)
	const kept = keptCollections(operations, nouns)
	for (const op of operations) {
		if (op.entity === null || op.entitySource === "tag" || nouns.has(op.entity)) continue
		if (op.action === "create" && kept.has(`${op.entity}\u0000${op.path}`)) continue
		if (isView(op)) {
			/* A collection-shaped GET with no item route is usually a named view of another
			 * entity (`/table-templates/mine`). oat cannot know which, so it says so. */
			views.push(op)
			continue
		}
		demote(op, nouns, gaps)
	}
	return views
}

/** Nouns the API exposes an item route for: `<noun>/{param}`. */
function nounsWithItemRoute(operations: readonly OperationModel[]): Set<string> {
	const nouns = new Set<string>()
	for (const op of operations) {
		const segments = segmentsOf(op.path)
		for (let i = 1; i < segments.length; i++) {
			const seg = segments[i] as string
			const prev = segments[i - 1] as string
			if (isParamSegment(seg) && !isParamSegment(prev)) nouns.add(singularize(prev))
		}
	}
	return nouns
}

/**
 * A noun kept for its collection GET keeps the create posted to the same collection: the
 * decision is per noun, so an entity is never left listable but not creatable.
 */
function keptCollections(operations: readonly OperationModel[], nouns: ReadonlySet<string>): Set<string> {
	return new Set(
		operations
			.filter((op) => op.entity !== null && op.entitySource !== "tag" && !nouns.has(op.entity) && isView(op))
			.map((op) => `${op.entity}\u0000${op.path}`),
	)
}

function isView(op: OperationModel): boolean {
	return op.method === "GET" && op.collection !== null && !isVerbPhrase(op.path)
}

/** Makes `op` an action on its nearest enclosing entity, or on none. */
function demote(op: OperationModel, nouns: ReadonlySet<string>, gaps: GapCollector): void {
	const parent = enclosingEntity(op.path, nouns)
	if (parent === null) {
		gaps.record(
			op.operationId,
			"x-entity",
			`"${op.path}" names no collection with an item route and sits under none, so it belongs ` +
				"to no entity and gets no lifecycle coverage. Name its entity with x-entity",
		)
	}
	op.entity = parent
	op.action = parent === null ? null : "action"
}

/* Asked only of a heuristic entity outside `nounsWithItemRoute`, which was read off a trailing literal segment. */
function isVerbPhrase(path: string): boolean {
	return VERB_PREFIX.test(segmentsOf(path).at(-1) as string)
}

/** Nearest ancestor segment in the path that names a real entity. */
function enclosingEntity(path: string, entities: ReadonlySet<string>): string | null {
	const segments = segmentsOf(path)
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i] as string
		if (isParamSegment(seg)) continue
		const name = singularize(seg)
		if (entities.has(name)) return name
	}
	return null
}
