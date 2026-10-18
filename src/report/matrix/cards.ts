/**
 * Entity cards under the band: one per entity with its poster cells as dots, or, for a crowd, one
 * per entity that disagreed or stood down.
 */

import { NODE_ORDER } from "./catalog.ts"
import { nodeOf } from "./slice.ts"
import { esc, unique } from "./text.ts"
import type { EntityMatrix, MatrixGraph } from "./types.ts"

/** Which other entities `entity`'s writes are declared to change. */
function invalidatesText(graph: MatrixGraph, entity: EntityMatrix): string {
	const outbound = graph.invalidate.filter((l) => l.fromEntity === entity.name && l.cross)
	return outbound.length === 0
		? "does not invalidate another entity"
		: `invalidates ${unique(outbound.map((l) => l.toEntity)).join(", ")}`
}

export function entityCards(graph: MatrixGraph): string {
	const cards = graph.entities.map((entity) => {
		const loomDots = NODE_ORDER.map(
			(spec) => `<span class="dot ${nodeOf(entity, spec.id).status}" title="${esc(spec.label)}"></span>`,
		).join("")
		return `<div class="card">
      <h2>${esc(entity.name)}</h2>
      <div class="meta">${entity.identity === null ? "no identity" : `id ${esc(entity.name)}.${esc(entity.identity)}`} · ${entity.readSurface.length} surfaces · ${esc(invalidatesText(graph, entity))}</div>
      <div class="dots">${loomDots}</div>
    </div>`
	})
	return `<div class="cards">${cards.join("")}</div>`
}

/** A crowd's cards: every entity that disagreed, and up to eight that only stood down. */
export function forestSummary(graph: MatrixGraph): string {
	const failed = graph.entities.filter((e) => e.counts.failed > 0)
	const blocked = graph.entities.filter((e) => e.counts.blocked > 0 && e.counts.failed === 0)
	const passed = graph.entities.filter((e) => e.counts.failed === 0 && e.counts.blocked === 0)
	const cards = [...failed, ...blocked.slice(0, 8)].map(
		(entity) => `<div class="card">
      <h2>${esc(entity.name)}</h2>
      <div class="meta">${entity.counts.failed} disagreed · ${entity.counts.blocked} stood down · ${esc(invalidatesText(graph, entity))}</div>
    </div>`,
	)
	return `<div class="crowd-note">
    ${passed.length} entities passed every check that applied.
    ${failed.length === 0 ? "Showing the detail view for one writer, not all 200 entities." : `Showing ${failed.length} entities that disagreed.`}
  </div>
  ${cards.length > 0 ? `<div class="cards">${cards.join("")}</div>` : ""}`
}
