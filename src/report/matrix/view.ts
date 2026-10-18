/** One entity's matrix as the poster's cells: the read, item, axis and composition checks, in order. */

import { checkCatalog, NODE_ORDER } from "./catalog.ts"
import { reportRows, rowsOfReport } from "./rows.ts"
import { entitySlice, nodeOf } from "./slice.ts"
import type { MatrixNode, MatrixParts, MatrixReport, MatrixView } from "./types.ts"

/** The first entity the run tested; a report that tested none draws a placeholder `entity`. */
export function matrixViewFromReport(input: MatrixReport): MatrixView {
	const entity = input.entitiesTested[0] ?? "entity"
	return matrixViewFromParts({
		...rowsOfReport(input),
		baseUrl: input.baseUrl,
		entity,
		generatedAt: input.startedAt.toISOString(),
		readSurface: input.model.entities.get(entity)?.readSurface ?? [],
	})
}

export function matrixViewFromParts(parts: MatrixParts): MatrixView {
	const entity = { identity: null, name: parts.entity, readSurface: parts.readSurface }
	const slice = entitySlice(entity, checkCatalog(), reportRows(parts))
	const nodes = NODE_ORDER.map((spec): MatrixNode => {
		const { because, status } = nodeOf(slice, spec.id)
		const node: MatrixNode = { hint: spec.hint, id: spec.id, label: spec.label, status }
		/* A blocked cell stood down for a suppressed row, and the slice carries that row's cause. */
		if (status === "blocked") node.because = because as string
		if (status === "failed") node.hint = "disagreed"
		return node
	})
	return {
		baseUrl: parts.baseUrl,
		blocked: slice.counts.blocked,
		entity: parts.entity,
		failed: slice.counts.failed,
		generatedAt: parts.generatedAt,
		passed: slice.counts.passed,
		nodes,
		readSurface: parts.readSurface,
		skipped: slice.counts.skipped,
	}
}
