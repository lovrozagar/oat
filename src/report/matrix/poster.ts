/**
 * The run's matrix as a poster: the entities and their invalidate claims, the focus entity's checks
 * as a loom, and its strips of chips.
 */

import { entityBand } from "./band.ts"
import { entityCards, forestSummary } from "./cards.ts"
import { buildMatrixGraph, buildMatrixGraphFromReport } from "./graph.ts"
import { loomSvg } from "./loom.ts"
import { focusOf } from "./slice.ts"
import { stripHtml } from "./strips.ts"
import { posterStyle } from "./style.ts"
import { esc } from "./text.ts"
import type { EntityMatrix, MatrixGraph, MatrixParts, MatrixReport } from "./types.ts"

export function renderMatrixFromParts(parts: MatrixParts): string {
	return renderPoster(buildMatrixGraph(parts))
}

export function renderMatrixHtml(input: MatrixReport): string {
	return renderPoster(buildMatrixGraphFromReport(input))
}

/** The poster of a graph built here: one with at least one entity, never compacted. */
export function renderPoster(graph: MatrixGraph): string {
	return `${posterHead(graph)}${posterBody(graph)}`
}

function posterHead(graph: MatrixGraph): string {
	const names =
		graph.entities.length <= 8 ? graph.entities.map((e) => e.name).join(", ") : `${graph.entities.length} entities`
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oat matrix — ${esc(names)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
<style>
${posterStyle(graph.entities.length)}</style>
</head>
`
}

function posterBody(graph: MatrixGraph): string {
	const multi = graph.entities.length > 1
	const crowded = graph.entities.length > 24
	const focus = focusOf(graph.entities, graph.invalidate)
	const surface = focus.readSurface.map((r) => `<code>${esc(r)}</code>`).join("<span> · </span>")
	return `<body>
<article class="poster">
  ${headerHtml(graph, multi)}

  <div class="band">
    <div class="band-label">entities and x-invalidate</div>
    ${entityBand(graph)}
    <div class="legend">
      <span><i class="swatch passed"></i>own read surface</span>
      <span><i class="swatch failed"></i>cross-entity invalidate — the check that needs two entities</span>
    </div>
  </div>

  ${multi && !crowded ? entityCards(graph) : ""}
  ${crowded ? forestSummary(graph) : ""}

  <div class="stage">
    <div class="stage-label">checks — ${esc(focus.name)}</div>
    ${loomSvg(focus)}
    <div class="legend">
      <span><i class="swatch passed"></i>passed</span>
      <span><i class="swatch failed"></i>disagreed — a finding</span>
      <span><i class="swatch blocked"></i>blocked — an earlier check it depends on already failed</span>
      <span><i class="swatch skipped"></i>did not apply — the document has no support for this check</span>
      ${graph.counts["out-of-scope"] > 0 ? '<span><i class="swatch out-of-scope"></i>out of scope — --ops did not target it</span>' : ""}
    </div>
  </div>

  <div class="strips">${crowded ? "" : stripHtml(focus, multi)}</div>

  <footer>
    <div>${surface === "" ? "" : `read surface ${surface}`}</div>
    <div>${esc(graph.baseUrl)} · ${esc(graph.generatedAt)}</div>
  </footer>
</article>
</body>
</html>
`
}

function headerHtml(graph: MatrixGraph, multi: boolean): string {
	return `<header>
    <div>
      <div class="kicker">${multi ? "many entities · invalidate is an edge" : "same fact · many checks"}</div>
      <h1>${headerTitle(graph)}</h1>
      <p class="thesis">${esc(graph.thesis)}</p>
    </div>
    <div class="counts">
      <div class="failed"><b>${graph.counts.failed}</b><span>disagreed</span></div>
      <div class="blocked"><b>${graph.counts.blocked}</b><span>blocked</span></div>
      <div class="passed"><b>${graph.counts.passed}</b><span>passed</span></div>
      <div class="skipped"><b>${graph.counts.skipped}</b><span>did not apply</span></div>
      ${graph.counts["out-of-scope"] > 0 ? `<div class="skipped"><b>${graph.counts["out-of-scope"]}</b><span>out of scope</span></div>` : ""}
    </div>
  </header>`
}

function headerTitle(graph: MatrixGraph): string {
	if (graph.entities.length <= 1)
		return `${esc((graph.entities[0] as EntityMatrix).name)} was asked<br>through independent projections`
	const cross = graph.invalidate.filter((l) => l.cross).length
	return `${graph.entities.length} entities, ${cross} cross-entity claim${cross === 1 ? "" : "s"}`
}
