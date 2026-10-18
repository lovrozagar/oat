/**
 * One entity's slice of the matrix: a node per catalogued check with the status the report gave
 * it, the counts, and the failed checks no other failure explains.
 */

import { isRootCause } from "../../runtime/finding.ts"
import type { CheckCatalog, Strip } from "./catalog.ts"
import { onPrimary, type ReportRows, rowsFor } from "./rows.ts"
import type { CellStatus, EntityMatrix, InvalidateLink, MatrixGraphNode } from "./types.ts"

/** The entity a slice is cut for, as the document's model has it. */
export interface SliceEntity {
	name: string
	readSurface: string[]
	identity: string | null
}

export function entitySlice(entity: SliceEntity, catalog: CheckCatalog, rows: ReportRows): EntityMatrix {
	const nodes = catalog.ids.map((id) => graphNode({ entity: entity.name, id }, catalog, rows))
	const counts: Record<CellStatus, number> = { blocked: 0, failed: 0, passed: 0, "out-of-scope": 0, skipped: 0 }
	for (const node of nodes) counts[node.status] += 1

	const failedSet = new Set(nodes.filter((n) => n.status === "failed").map((n) => n.id))
	const roots = [...failedSet].filter(
		(id) => !catalog.edges.some((e) => e.kind === "dependsOn" && e.to === id && failedSet.has(e.from)),
	)

	return { counts, identity: entity.identity, name: entity.name, nodes, readSurface: entity.readSurface, roots }
}

/* One cell of the matrix: check `id` on `entity`. */
interface Cell {
	entity: string
	id: string
}

function graphNode({ entity, id }: Cell, catalog: CheckCatalog, rows: ReportRows): MatrixGraphNode {
	/* The catalog's ids are the ids of its strips: every one has a strip. */
	const strip = catalog.stripOf.get(id) as Strip
	const node: MatrixGraphNode = { group: strip.title, id, layer: strip.layer, status: statusFor(entity, id, rows) }
	const need = catalog.needs.get(id)
	if (need !== undefined) node.needs = need
	const suppressed = rowsFor(rows.suppressed, id, entity)[0]
	if (suppressed !== undefined) node.because = suppressed.because
	const finding = rowsFor(rows.findings, id, entity).find(onPrimary)
	if (finding !== undefined) {
		node.summary = finding.summary
		node.verdict = finding.verdict
	}
	return node
}

function statusFor(entity: string, id: string, rows: ReportRows): CellStatus {
	const finding = rowsFor(rows.findings, id, entity).find((f) => onPrimary(f) && isRootCause(f))
	if (finding !== undefined) return "failed"
	if (rowsFor(rows.suppressed, id, entity).length > 0) return "blocked"
	if (rowsFor(rows.skipped, id, entity).length > 0) return "skipped"
	if (rowsFor(rows.outOfScope, id, entity).length > 0) return "out-of-scope"
	if (rows.ran.has(id)) return "passed"
	return "skipped"
}

/**
 * The node a slice holds for check `id`. Every slice carries a node for every catalogued check, and
 * the poster and the mermaid source only ask for catalogued ones.
 */
export function nodeOf(entity: EntityMatrix, id: string): MatrixGraphNode {
	return entity.nodes.find((n) => n.id === id) as MatrixGraphNode
}

/**
 * The slice the detail views draw: the first entity whose writes reach another entity, else the
 * first entity. Every graph holds at least one entity.
 */
export function focusOf(entities: readonly EntityMatrix[], invalidate: readonly InvalidateLink[]): EntityMatrix {
	const writer = entities.find((e) => invalidate.some((l) => l.cross && l.fromEntity === e.name))
	return writer ?? (entities[0] as EntityMatrix)
}
