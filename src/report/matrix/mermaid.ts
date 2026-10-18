/**
 * The graph as mermaid source: entities and their cross-entity invalidate edges, then the focus
 * entity's query checks. A crowd of entities draws only the parents that receive writes.
 */

import { NODE_ORDER, USES } from "./catalog.ts"
import { focusOf, nodeOf } from "./slice.ts"
import { esc } from "./text.ts"
import type { EntityMatrix, InvalidateLink } from "./types.ts"

const CLASS_DEFS = [
	"  classDef passed stroke:#7dcea0",
	"  classDef failed stroke:#ff6b3d,color:#ff6b3d",
	"  classDef blocked stroke:#6d7686,stroke-dasharray: 4 4",
	"  classDef skipped stroke:#3d4758",
	"  classDef out-of-scope stroke:#3d4758,stroke-dasharray: 2 4",
]

/** `id` as a mermaid node id. */
function mid(id: string): string {
	return id.replaceAll(/[^A-Za-z0-9_]/g, "_")
}

export function mermaidFromGraph(entities: readonly EntityMatrix[], invalidate: readonly InvalidateLink[]): string {
	if (entities.length > 24) return crowdMermaid(entities.length, invalidate)
	return [
		"flowchart LR",
		...entities.map((entity) => `  ${mid(entity.name)}((${esc(entity.name)}))`),
		...invalidate.filter((l) => l.cross).map((l) => `  ${mid(l.fromEntity)} -->|invalidates| ${mid(l.toEntity)}`),
		...focusLines(focusOf(entities, invalidate)),
		...CLASS_DEFS,
	].join("\n")
}

/** The 24 parents that receive the most cross-entity claims, and a note of how many entities there are. */
function crowdMermaid(count: number, invalidate: readonly InvalidateLink[]): string {
	const inbound = new Map<string, number>()
	for (const invalidation of invalidate) {
		if (invalidation.cross) inbound.set(invalidation.toEntity, (inbound.get(invalidation.toEntity) ?? 0) + 1)
	}
	const parents = [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
	return [
		"flowchart LR",
		...parents.map(([parent, n]) => `  ${mid(parent)}(("${parent} ← ${n}"))`),
		`  note["${count} entities, compact"]`,
	].join("\n")
}

/** The focus entity's query checks: reads and axes hang off the entity, compositions off their axes. */
function focusLines(focus: EntityMatrix): string[] {
	const lines: string[] = []
	for (const spec of NODE_ORDER) {
		const node = nodeOf(focus, spec.id)
		const sid = mid(`${focus.name}__${spec.id}`)
		lines.push(`  ${sid}["${spec.label}"]`)
		if (
			node.layer === "axis" ||
			spec.id === "list.read-after-write" ||
			spec.id === "tenant.item-not-readable-cross-tenant"
		) {
			lines.push(`  ${mid(focus.name)} --> ${sid}`)
		}
		lines.push(`  class ${sid} ${node.status}`)
	}
	for (const edge of USES) {
		const dest = nodeOf(focus, edge.to)
		const arrow =
			dest.status === "blocked" || dest.status === "skipped" || dest.status === "out-of-scope" ? "-.->" : "-->"
		lines.push(`  ${mid(`${focus.name}__${edge.from}`)} ${arrow} ${mid(`${focus.name}__${edge.to}`)}`)
	}
	return lines
}
