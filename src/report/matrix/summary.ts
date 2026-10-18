/** What the whole matrix says: totals across entities, a one-line summary, and the thesis. */

import { unique } from "./text.ts"
import type { CellStatus, EntityMatrix, InvalidateLink } from "./types.ts"

export function totalCounts(entities: readonly EntityMatrix[]): Record<CellStatus, number> {
	const counts: Record<CellStatus, number> = { blocked: 0, failed: 0, passed: 0, "out-of-scope": 0, skipped: 0 }
	for (const entity of entities) {
		for (const status of Object.keys(counts) as CellStatus[]) counts[status] += entity.counts[status]
	}
	return counts
}

/** The summary line. `cross` is the cross-entity links only. */
export function summaryLine(
	entities: readonly EntityMatrix[],
	counts: Record<CellStatus, number>,
	cross: readonly InvalidateLink[],
): string {
	const names = entities.map((e) => e.name)
	const rootList = entities.flatMap((e) => e.roots.map((id) => `${e.name}:${id}`))
	const who = names.length > 12 ? `${names.length} entities` : names.join(", ")
	return (
		`${who}: ${counts.failed} failed, ${counts.blocked} blocked, ${counts.passed} passed, ${counts.skipped} skipped` +
		(counts["out-of-scope"] > 0 ? `, ${counts["out-of-scope"]} out of scope.` : ".") +
		crossSentence(cross) +
		(rootList.length > 0 && rootList.length <= 8 ? ` Roots: ${rootList.join(", ")}.` : "")
	)
}

function crossSentence(cross: readonly InvalidateLink[]): string {
	if (cross.length > 8) {
		return ` ${unique(cross.map((l) => l.toEntity)).length} parents receive ${cross.length} cross-entity claims.`
	}
	if (cross.length > 0) {
		return ` Cross-entity invalidate: ${unique(cross.map((l) => `${l.fromEntity} → ${l.toEntity}`)).join(", ")}.`
	}
	return " No cross-entity invalidate."
}

/** The poster's thesis. `cross` is the cross-entity links only. */
export function thesisFor(entities: readonly EntityMatrix[], cross: readonly InvalidateLink[]): string {
	const failed = entities.find((e) => e.counts.failed > 0)
	if (failed !== undefined) {
		return `${failed.name} had a check that disagreed. Composition checks that depend on it stood down — not extra defects.`
	}
	if (entities.length === 1 && cross.length === 0) {
		return "One entity. Invalidate stays on its own read surface, so the cross-entity check did not apply."
	}
	if (cross.length > 0) {
		const parents = unique(cross.map((l) => l.toEntity))
		if (cross.length > 8) {
			return `${entities.length} entities. ${parents.length} parents receive child writes (${cross.length} claims) — tested, not believed.`
		}
		const pairs = unique(cross.map((l) => `${l.fromEntity} writes must change ${l.toEntity}`))
		return `${entities.length} entities. ${pairs.join("; ")} — that claim was tested, not believed.`
	}
	return `${entities.length} entities. Every check that applied agreed.`
}
