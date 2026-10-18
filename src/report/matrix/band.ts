/**
 * The poster's top band: every entity as a pin, with an arrow for each cross-entity invalidate
 * claim. A crowd of entities draws the parents that receive writes as bars instead.
 */

import { esc } from "./text.ts"
import type { EntityMatrix, MatrixGraph, Point } from "./types.ts"

const WIDTH = 1120
const ROW_HEIGHT = 96
const TOP = 56
const PIN = "#f0c14b"

export function entityBand(graph: MatrixGraph): string {
	if (graph.entities.length > 24) return crowdedBand(graph)
	const { height, pos } = bandLayout(graph.entities.map((e) => e.name))
	const pins = graph.entities.map((entity) => pinSvg(entity, pos.get(entity.name) as Point))
	return `<svg viewBox="0 0 1120 ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Entity invalidate graph">
    <defs>
      <marker id="arrow-cross" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#ff6b3d"/></marker>
      <marker id="arrow-self" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#6d7686"/></marker>
    </defs>
    ${emptyNote(graph)}
    ${crossArrows(graph, pos).join("\n")}
    ${pins.join("\n")}
  </svg>`
}

/** Pins in rows: all in one row up to six, two rows up to twelve, then rows of five. */
function bandLayout(names: readonly string[]): { height: number; pos: ReadonlyMap<string, Point> } {
	const n = names.length
	const perRow = n <= 6 ? n : n <= 12 ? Math.ceil(n / 2) : 5
	const rows = Math.ceil(n / perRow)
	const pos = new Map(
		names.map((name, i) => {
			const row = Math.floor(i / perRow)
			const col = i % perRow
			const inRow = Math.min(perRow, n - row * perRow)
			const slot = WIDTH / (inRow + 1)
			return [name, { x: slot * (col + 1), y: TOP + row * ROW_HEIGHT }] as const
		}),
	)
	return { height: Math.max(160, TOP + rows * ROW_HEIGHT + 20), pos }
}

function pinSvg(entity: EntityMatrix, at: Point): string {
	const surfaces = entity.readSurface.length
	return `<g>
      <circle cx="${at.x}" cy="${at.y}" r="16" fill="${PIN}"/>
      <circle cx="${at.x}" cy="${at.y}" r="6" fill="#243044"/>
      <text x="${at.x}" y="${at.y + 36}" text-anchor="middle" fill="${PIN}" font-size="14" font-family="Syne, sans-serif" font-weight="700">${esc(entity.name)}</text>
      <text x="${at.x}" y="${at.y + 52}" text-anchor="middle" fill="#9aa3b2" font-size="10" font-family="IBM Plex Mono, monospace">${surfaces} read surface${surfaces === 1 ? "" : "s"}</text>
    </g>`
}

/** One arrow per writer → parent pair. A pair whose entity the run did not test has no pin, so no arrow. */
function crossArrows(graph: MatrixGraph, pos: ReadonlyMap<string, Point>): string[] {
	const pairs = new Map<string, { from: string; to: string }>()
	for (const invalidation of graph.invalidate) {
		if (!invalidation.cross) continue
		pairs.set(`${invalidation.fromEntity}\0${invalidation.toEntity}`, {
			from: invalidation.fromEntity,
			to: invalidation.toEntity,
		})
	}
	const labelArrows = graph.entities.length <= 8
	return [...pairs.values()].map((pair) => {
		const from = pos.get(pair.from)
		const to = pos.get(pair.to)
		if (from === undefined || to === undefined) return ""
		const midX = (from.x + to.x) / 2
		const lift = from.y === to.y ? 36 : Math.abs(to.y - from.y) / 2 + 16
		const midY = Math.min(from.y, to.y) - lift
		const label = labelArrows
			? `<text x="${midX}" y="${midY - 4}" text-anchor="middle" fill="#ff6b3d" font-size="11" font-family="IBM Plex Mono, monospace">${esc(`${pair.from} → ${pair.to}`)}</text>`
			: ""
		return `<path d="M ${from.x} ${from.y - 16} Q ${midX} ${midY}, ${to.x} ${to.y - 16}" fill="none" stroke="#ff6b3d" stroke-width="1.6" marker-end="url(#arrow-cross)"/>${label}`
	})
}

/** Why the band has no arrows, when it has none. */
function emptyNote(graph: MatrixGraph): string {
	if (graph.invalidate.some((l) => l.cross)) return ""
	return `<text x="560" y="36" text-anchor="middle" fill="#9aa3b2" font-size="12" font-family="IBM Plex Mono, monospace">${
		graph.invalidate.length === 0
			? "no x-invalidate edges in this document"
			: "invalidate stays on the same entity — the cross-entity check did not apply"
	}</text>`
}

/** The 24 parents with the most writers as bars, and how many entities sit outside every claim. */
function crowdedBand(graph: MatrixGraph): string {
	const inbound = new Map<string, string[]>()
	for (const invalidation of graph.invalidate) {
		if (!invalidation.cross) continue
		const list = inbound.get(invalidation.toEntity) ?? []
		if (!list.includes(invalidation.fromEntity)) list.push(invalidation.fromEntity)
		inbound.set(invalidation.toEntity, list)
	}
	const parents = [...inbound.entries()].sort((a, b) => b[1].length - a[1].length)
	const max = Math.max(1, ...parents.map(([, w]) => w.length))
	const rows = parents
		.slice(0, 24)
		.map(([parent, writers]) => {
			const width = Math.max(4, Math.round((writers.length / max) * 240))
			return `<div class="bar-row">
        <div class="bar-name">${esc(parent)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}px"></div></div>
        <div class="bar-n">${writers.length} writers</div>
      </div>`
		})
		.join("")
	const more = parents.length > 24 ? `<div class="bar-more">${parents.length - 24} more parents</div>` : ""
	const orphans = graph.entities.length - new Set([...inbound.keys(), ...[...inbound.values()].flat()]).size
	return `<div class="forest">
    <p class="forest-lead">${graph.entities.length} entities · ${
			graph.invalidate.filter((l) => l.cross).length
		} cross-entity claims · ${parents.length} parents · ${orphans} with no invalidate edge</p>
    ${rows}${more}
  </div>`
}
