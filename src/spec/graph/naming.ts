/**
 * One inferred name, two collections: `/projects/{id}/members` and `/orgs/{id}/members` both
 * read as `member`, and fusing them would seed one through the other's routes. An entity is its
 * collection's path template, so same-named collections under different parents are told apart
 * by their parents: `project-member` and `org-member`. A tagged name is the author's and stays.
 */

import { singularize } from "../extensions/entity.ts"
import { isParamSegment, segmentsOf, templateKey } from "./segments.ts"
import type { OperationModel } from "./types.ts"

export function separateSameNamedCollections(operations: OperationModel[]): void {
	const renamed = new Map<string, string>()
	for (const [name, byTemplate] of collectionTemplates(operations)) {
		if (byTemplate.size < 2) continue
		for (const [template, to] of distinctNames(name, byTemplate)) renamed.set(`${name}\u0000${template}`, to)
	}
	if (renamed.size === 0) return
	for (const op of operations) {
		const segments = heuristicTemplate(op)
		if (segments === null) continue
		const to = renamed.get(`${op.entity}\u0000${templateKey(segments)}`)
		if (to !== undefined) op.entity = to
	}
}

/** Each heuristic entity name, with the collection templates that carry it. */
function collectionTemplates(operations: readonly OperationModel[]): Map<string, Map<string, string[]>> {
	const templates = new Map<string, Map<string, string[]>>()
	for (const op of operations) {
		const segments = heuristicTemplate(op)
		if (segments === null) continue
		const name = op.entity as string
		const byName = templates.get(name) ?? new Map<string, string[]>()
		byName.set(templateKey(segments), segments)
		templates.set(name, byName)
	}
	return templates
}

/** The collection an operation's heuristic entity name was read from, up to that segment. */
function heuristicTemplate(op: OperationModel): string[] | null {
	if (op.entity === null || op.entitySource !== "heuristic") return null
	const segments = segmentsOf(op.path)
	for (let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i] as string
		if (!isParamSegment(segment) && singularize(segment) === op.entity) return segments.slice(0, i + 1)
	}
	return null
}

/** Prefix ancestors until every collection of this name reads differently. */
function distinctNames(name: string, byTemplate: ReadonlyMap<string, string[]>): Map<string, string> {
	for (let depth = 1; ; depth++) {
		const names = new Map<string, string>()
		for (const [template, segments] of byTemplate) {
			const parents = segments
				.slice(0, -1)
				.filter((segment) => !isParamSegment(segment) && !/^v\d+$/i.test(segment))
				.slice(-depth)
				.map(singularize)
			names.set(template, [...parents, name].join("-"))
		}
		const exhausted = [...byTemplate.values()].every(
			(segments) => segments.slice(0, -1).filter((s) => !isParamSegment(s)).length <= depth,
		)
		if (new Set(names.values()).size === names.size || exhausted) return names
	}
}
