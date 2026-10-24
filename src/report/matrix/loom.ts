/**
 * The poster's loom: the focus entity's cohort as a pin, its reads and single axes as the warp,
 * and the composition checks built from them as the weft.
 */

import { type CellSpec, NODE_ORDER } from "./catalog.ts"
import { nodeOf } from "./slice.ts"
import { esc } from "./text.ts"
import type { CellStatus, EntityMatrix, Point } from "./types.ts"

const COHORT: Point = { x: 130, y: 270 }

/** Reads and single axes, each tied to the cohort. */
const WARP: ReadonlyArray<Point & { id: string }> = [
	{ id: "tenant.item-not-readable-cross-tenant", x: 130, y: 70 },
	{ id: "list.read-after-write", x: 130, y: 150 },
	{ id: "consistency.projections-agree", x: 130, y: 390 },
	{ id: "filter.equality-selects-exactly-one", x: 390, y: 90 },
	{ id: "sort.order-is-applied", x: 390, y: 180 },
	{ id: "select.projection-honored", x: 390, y: 270 },
	{ id: "search.q-narrows-result", x: 390, y: 360 },
	{ id: "pagination.page-walk-covers-set", x: 390, y: 450 },
]

/** Composition checks, each tied to the checks it is built from. */
const WEFT: ReadonlyArray<Point & { id: string; from: readonly string[] }> = [
	{ from: ["filter.equality-selects-exactly-one", "sort.order-is-applied"], id: "query.axes-compose", x: 700, y: 110 },
	{
		from: ["filter.equality-selects-exactly-one", "select.projection-honored"],
		id: "query.filter-and-select-compose",
		x: 700,
		y: 220,
	},
	{
		from: ["filter.equality-selects-exactly-one", "search.q-narrows-result"],
		id: "query.search-and-filter-compose",
		x: 700,
		y: 330,
	},
	{
		from: ["filter.equality-selects-exactly-one", "pagination.page-walk-covers-set"],
		id: "query.filter-selects-from-whole-set",
		x: 700,
		y: 450,
	},
	{
		from: ["query.axes-compose", "query.filter-and-select-compose"],
		id: "query.filter-sort-select-compose",
		x: 980,
		y: 160,
	},
	{
		from: ["query.axes-compose", "query.search-and-filter-compose"],
		id: "query.filter-search-sort-compose",
		x: 980,
		y: 270,
	},
	{
		from: ["query.filter-and-select-compose", "query.search-and-filter-compose"],
		id: "query.filter-search-select-compose",
		x: 980,
		y: 380,
	},
]

const LABEL = 'fill="#9aa3b2" font-size="11" letter-spacing="2" font-family="IBM Plex Mono, monospace"'

export function loomSvg(focus: EntityMatrix): string {
	const status = (id: string): CellStatus => nodeOf(focus, id).status
	/* Every `from` names a warp or weft station. */
	const at = (id: string): Point => [...WARP, ...WEFT].find((node) => node.id === id) as Point
	const lines = [
		...WARP.map((node) => link(COHORT, node, status(node.id))),
		...WEFT.flatMap((node) => node.from.map((src) => link(at(src), node, status(node.id)))),
	]
	/* Every station is a poster cell. */
	const stations = [...WARP, ...WEFT].map((pt) =>
		box(pt, NODE_ORDER.find((s) => s.id === pt.id) as CellSpec, status(pt.id)),
	)
	return `<svg viewBox="0 0 1120 540" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Query checks for ${esc(focus.name)}">
    <text x="48" y="24" ${LABEL}>READS</text>
    <text x="360" y="24" ${LABEL}>AXES</text>
    <text x="650" y="24" ${LABEL}>PAIRS</text>
    <text x="930" y="24" ${LABEL}>TRIPLES</text>
    ${lines.join("\n")}
    <circle cx="${COHORT.x}" cy="${COHORT.y}" r="18" fill="#f0c14b"/>
    <circle cx="${COHORT.x}" cy="${COHORT.y}" r="7" fill="#243044"/>
    <text x="${COHORT.x}" y="${COHORT.y + 38}" text-anchor="middle" fill="#f0c14b" font-size="13" font-family="Syne, sans-serif" font-weight="700">${esc(focus.name)}</text>
    <text x="${COHORT.x}" y="${COHORT.y + 54}" text-anchor="middle" fill="#9aa3b2" font-size="10" font-family="IBM Plex Mono, monospace">one cohort</text>
    ${stations.join("\n")}
  </svg>`
}

function strokeOf(status: CellStatus): string {
	return status === "failed"
		? "#ff6b3d"
		: status === "passed"
			? "#7dcea0"
			: status === "blocked"
				? "#6d7686"
				: "#3d4758"
}

/** A check that did not run is drawn dashed. */
function dashed(status: CellStatus): boolean {
	return status === "blocked" || status === "skipped" || status === "out-of-scope"
}

function link(from: Point, to: Point, status: CellStatus): string {
	const dash = dashed(status) ? 'stroke-dasharray="5 5"' : ""
	return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${strokeOf(status)}" stroke-width="1.6" ${dash}/>`
}

/** A station: the cell's label, and under it its hint, `disagreed`, or nothing while it stood down. */
function box(pt: Point, spec: CellSpec, status: CellStatus): string {
	const caption = status === "failed" ? "disagreed" : status === "blocked" ? "" : spec.hint
	const fill = status === "failed" ? "#ff6b3d" : "#1b2332"
	const ink = status === "failed" ? "#243044" : status === "passed" ? "#7dcea0" : "#9aa3b2"
	const dash = dashed(status) ? 'stroke-dasharray="3 3"' : ""
	const w = Math.max(92, spec.label.length * 7.4 + 22)
	const cap =
		caption === ""
			? ""
			: `<text x="${pt.x}" y="${pt.y + 28}" text-anchor="middle" fill="#9aa3b2" font-size="10" font-family="IBM Plex Mono, monospace">${esc(caption)}</text>`
	return `<g>
    <rect x="${pt.x - w / 2}" y="${pt.y - 15}" width="${w}" height="30" rx="2" fill="${fill}" stroke="${strokeOf(status)}" ${dash}/>
    <text x="${pt.x}" y="${pt.y + 5}" text-anchor="middle" fill="${ink}" font-size="12" font-family="Syne, sans-serif" font-weight="700">${esc(spec.label)}</text>
    ${cap}
  </g>`
}
