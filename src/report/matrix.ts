/**
 * Poster + machine graph of how oat crossed the entities in a run.
 *
 * One entity gets its own graph: single-axis checks (filter, sort, search, select, page/count)
 * on one cohort, composition checks that only run once every axis they combine has held. Several
 * entities add a second graph on top — `x-invalidate` edges from a writer to another entity's
 * read surface. That is the claim `invalidation.declared-route-changes` actually tests.
 */

import { CHECKS } from "../runtime/checks.ts"
import type { SpecModel } from "../spec/graph.ts"
import type { ReportInput } from "./render.ts"

export type CellStatus = "held" | "failed" | "blocked" | "skipped"
export type MatrixLayer = "axis" | "composition" | "surface" | "auth" | "schema" | "spec"

export interface MatrixView {
	entity: string
	baseUrl: string
	generatedAt: string
	readSurface: string[]
	failed: number
	blocked: number
	held: number
	skipped: number
	nodes: MatrixNode[]
}

export interface MatrixNode {
	id: string
	label: string
	hint: string
	status: CellStatus
	because?: string
}

export interface MatrixGraphNode {
	id: string
	group: string
	layer: MatrixLayer
	status: CellStatus
	needs?: string
	because?: string
	summary?: string
	verdict?: string
}

export interface MatrixGraphEdge {
	from: string
	to: string
	/** `dependsOn`: if `from` failed, `to` is blocked. `uses`: a composition check built from `from`. */
	kind: "dependsOn" | "uses"
}

export interface InvalidateLink {
	fromEntity: string
	fromOp: string
	toEntity: string
	toRoute: string
	/** True when the declared route belongs to a *different* entity — the case the check probes. */
	cross: boolean
}

export interface EntityMatrix {
	name: string
	identity: string | null
	readSurface: string[]
	counts: { failed: number; blocked: number; held: number; skipped: number }
	roots: string[]
	nodes: MatrixGraphNode[]
}

export interface MatrixGraph {
	kind: "oat.matrix"
	version: 2
	read: {
		purpose: string
		status: Record<CellStatus, string>
		edges: Record<MatrixGraphEdge["kind"] | "invalidate", string>
	}
	baseUrl: string
	generatedAt: string
	thesis: string
	summary: string
	index: {
		entityCount: number
		failed: string[]
		parents: string[]
		crossClaims: number
		inbound: Record<string, number>
	}
	counts: { failed: number; blocked: number; held: number; skipped: number }
	entities: EntityMatrix[]
	invalidate: InvalidateLink[]
	edges: MatrixGraphEdge[]
	mermaid: string
}

type MatrixParts = {
	entity: string
	baseUrl: string
	generatedAt: string
	readSurface: string[]
	checksRun: readonly string[]
	checksSkipped: ReadonlyArray<{ check: string; entity?: string; needs: string }>
	checksSuppressed: ReadonlyArray<{ check: string; entity?: string; because: string }>
	findings: ReadonlyArray<{
		check: string
		entity?: string
		verdict: string
		summary: string
		detail?: string
	}>
}

const NODE_ORDER: Array<{ id: string; label: string; hint: string }> = [
	{ hint: "create then list", id: "list.read-after-write", label: "list" },
	{ hint: "item GET agrees", id: "consistency.projections-agree", label: "item" },
	{ hint: "id.eq selects one", id: "filter.equality-selects-exactly-one", label: "filter" },
	{ hint: "order rearranges", id: "sort.order-is-applied", label: "sort" },
	{ hint: "sparse fieldset", id: "select.projection-honoured", label: "select" },
	{ hint: "q narrows", id: "search.q-narrows-result", label: "search" },
	{ hint: "walk covers set", id: "pagination.page-walk-covers-set", label: "page" },
	{ hint: "other tenant 404", id: "tenant.item-not-readable-cross-tenant", label: "tenant" },
	{ hint: "membership unchanged", id: "query.axes-compose", label: "filter + sort" },
	{ hint: "same rows, fewer fields", id: "query.filter-and-select-compose", label: "filter + select" },
	{ hint: "both predicates hold", id: "query.search-and-filter-compose", label: "filter + search" },
	{ hint: "filter before page", id: "query.filter-selects-from-whole-set", label: "filter / page" },
	{ hint: "three axes at once", id: "query.filter-sort-select-compose", label: "filter + sort + select" },
	{ hint: "three axes at once", id: "query.filter-search-sort-compose", label: "filter + search + sort" },
	{ hint: "three axes at once", id: "query.filter-search-select-compose", label: "filter + search + select" },
]

const USES: ReadonlyArray<{ from: string; to: string }> = [
	{ from: "filter.equality-selects-exactly-one", to: "query.axes-compose" },
	{ from: "sort.order-is-applied", to: "query.axes-compose" },
	{ from: "filter.equality-selects-exactly-one", to: "query.filter-and-select-compose" },
	{ from: "select.projection-honoured", to: "query.filter-and-select-compose" },
	{ from: "filter.equality-selects-exactly-one", to: "query.search-and-filter-compose" },
	{ from: "search.q-narrows-result", to: "query.search-and-filter-compose" },
	{ from: "filter.equality-selects-exactly-one", to: "query.filter-selects-from-whole-set" },
	{ from: "pagination.page-walk-covers-set", to: "query.filter-selects-from-whole-set" },
	{ from: "query.axes-compose", to: "query.filter-sort-select-compose" },
	{ from: "query.filter-and-select-compose", to: "query.filter-sort-select-compose" },
	{ from: "query.axes-compose", to: "query.filter-search-sort-compose" },
	{ from: "query.search-and-filter-compose", to: "query.filter-search-sort-compose" },
	{ from: "query.filter-and-select-compose", to: "query.filter-search-select-compose" },
	{ from: "query.search-and-filter-compose", to: "query.filter-search-select-compose" },
]

const GROUP_LAYER: Record<string, MatrixLayer> = {
	composition: "composition",
	filter: "axis",
	"page / count": "axis",
	schema: "schema",
	search: "axis",
	select: "axis",
	sort: "axis",
	"spec promise": "spec",
	"who may see it": "auth",
	"write / surface": "surface",
}

const STRIPS: Array<{ title: string; ids: string[] }> = [
	{
		ids: [
			"filter.unknown-field-rejected",
			"filter.equality-selects-exactly-one",
			"filter.zero-match-returns-none",
			"filter.negation-partitions-the-set",
			"filter.and-composes-as-intersection",
			"filter.or-composes-as-union",
			"filter.like-metacharacters-escaped",
			"filter.numeric-comparison-is-numeric",
			"error.malformed-filter-not-5xx",
		],
		title: "filter",
	},
	{ ids: ["sort.order-is-applied", "sort.reverse-symmetry"], title: "sort" },
	{ ids: ["select.projection-honoured"], title: "select" },
	{ ids: ["search.q-narrows-result"], title: "search" },
	{
		ids: [
			"pagination.page-walk-covers-set",
			"pagination.cursor-agrees-with-page",
			"pagination.limit-bounds-page-size",
			"pagination.limit-respects-documented-max",
			"pagination.has-more-is-accurate",
			"count.consistent-with-returned-page",
			"count.matches-filtered-set",
		],
		title: "page / count",
	},
	{
		ids: [
			"query.axes-compose",
			"query.filter-and-select-compose",
			"query.search-and-filter-compose",
			"query.filter-selects-from-whole-set",
			"query.filter-sort-select-compose",
			"query.filter-search-sort-compose",
			"query.filter-search-select-compose",
		],
		title: "composition",
	},
	{
		ids: [
			"spec.declared-filterable-is-filterable",
			"spec.declared-sortable-is-sortable",
			"spec.declared-selectable-is-selectable",
		],
		title: "spec promise",
	},
	{
		ids: [
			"tenant.item-not-readable-cross-tenant",
			"tenant.denial-does-not-reveal-existence",
			"tenant.filter-does-not-bypass-scope",
			"auth.rank-is-monotonic",
			"auth.invite-grants-then-revokes",
		],
		title: "who may see it",
	},
	{
		ids: [
			"list.read-after-write",
			"create.persists-submitted-fields",
			"payload.string-survives",
			"create.status-matches-document",
			"response.status-is-documented",
			"consistency.projections-agree",
			"softdelete.absent-from-default-list",
			"invalidation.declared-route-changes",
			"patch.minimality",
			"patch.immutable-field-rejected",
			"idempotency.replay-does-not-duplicate",
			"delete.absent-record-returns-404",
			"concurrency.no-lost-update",
			"effects.declared-effect-occurs",
			"async.reaches-terminal-state",
			"async.receipt-identifies-the-job",
		],
		title: "write / surface",
	},
	{
		ids: [
			"validation.enum-enforced",
			"validation.max-length-enforced",
			"validation.required-enforced",
			"validation.content-type-enforced",
			"schema.success-response-matches-document",
			"schema.error-response-matches-document",
		],
		title: "schema",
	},
]

const ALL_CHECK_IDS = [...new Set(STRIPS.flatMap((s) => s.ids))]
const GROUP_OF = new Map(STRIPS.flatMap((s) => s.ids.map((id) => [id, s.title] as const)))
const NEEDS = new Map(CHECKS.map((check) => [check.id, check.needs]))

const CHECK_EDGES: MatrixGraphEdge[] = [
	...CHECKS.flatMap((check) =>
		(check.dependsOn ?? []).map((dep): MatrixGraphEdge => ({ from: dep, kind: "dependsOn", to: check.id })),
	),
	...USES.map((use): MatrixGraphEdge => ({ ...use, kind: "uses" })),
]

export function matrixViewFromReport(input: ReportInput): MatrixView {
	const entity = input.entitiesTested[0] ?? "entity"
	return matrixViewFromParts({
		baseUrl: input.baseUrl,
		checksRun: input.checksRun,
		checksSkipped: input.checksSkipped ?? [],
		checksSuppressed: input.checksSuppressed ?? [],
		entity,
		findings: input.findings,
		generatedAt: input.startedAt.toISOString(),
		readSurface: input.model.entities.get(entity)?.readSurface ?? [],
	})
}

export function matrixViewFromParts(parts: MatrixParts): MatrixView {
	const slice = entitySlice(parts.entity, parts, parts.readSurface, null)
	const nodes: MatrixNode[] = NODE_ORDER.map((spec) => {
		const status = slice.nodes.find((n) => n.id === spec.id)?.status ?? "skipped"
		const node: MatrixNode = { hint: spec.hint, id: spec.id, label: spec.label, status }
		const cause = slice.nodes.find((n) => n.id === spec.id)?.because
		if (status === "blocked" && cause !== undefined) node.because = cause
		if (status === "failed") node.hint = "disagreed"
		return node
	})
	return {
		baseUrl: parts.baseUrl,
		blocked: slice.counts.blocked,
		entity: parts.entity,
		failed: slice.counts.failed,
		generatedAt: parts.generatedAt,
		held: slice.counts.held,
		nodes,
		readSurface: parts.readSurface,
		skipped: slice.counts.skipped,
	}
}

export function renderMatrixFromParts(parts: MatrixParts): string {
	return renderPoster(buildMatrixGraph(parts))
}

export function renderMatrixHtml(input: ReportInput): string {
	return renderPoster(buildMatrixGraphFromReport(input))
}

export function renderMatrixGraph(input: ReportInput): string {
	return `${JSON.stringify(compactMatrixGraph(buildMatrixGraphFromReport(input)), null, 2)}\n`
}

export function renderMatrixGraphFromParts(parts: MatrixParts): string {
	return `${JSON.stringify(compactMatrixGraph(buildMatrixGraph(parts)), null, 2)}\n`
}

export function buildMatrixGraphFromReport(input: ReportInput): MatrixGraph {
	const names = input.entitiesTested.length > 0 ? input.entitiesTested : ["entity"]
	const partsFor = (name: string): MatrixParts => ({
		baseUrl: input.baseUrl,
		checksRun: input.checksRun,
		checksSkipped: input.checksSkipped ?? [],
		checksSuppressed: input.checksSuppressed ?? [],
		entity: name,
		findings: input.findings,
		generatedAt: input.startedAt.toISOString(),
		readSurface: input.model.entities.get(name)?.readSurface ?? [],
	})
	const entities = names.map((name) => {
		const modelEntity = input.model.entities.get(name)
		return entitySlice(name, partsFor(name), modelEntity?.readSurface ?? [], modelEntity?.identity ?? null)
	})
	return assembleGraph(input.baseUrl, input.startedAt.toISOString(), entities, invalidateLinks(input.model))
}

export function buildMatrixGraph(parts: MatrixParts): MatrixGraph {
	const slice = entitySlice(parts.entity, parts, parts.readSurface, null)
	return assembleGraph(parts.baseUrl, parts.generatedAt, [slice], [])
}

function entitySlice(name: string, parts: MatrixParts, readSurface: string[], identity: string | null): EntityMatrix {
	const nodes: MatrixGraphNode[] = ALL_CHECK_IDS.map((id) => {
		const group = GROUP_OF.get(id) ?? "other"
		const node: MatrixGraphNode = {
			group,
			id,
			layer: GROUP_LAYER[group] ?? "surface",
			status: statusFor(name, id, parts),
		}
		const need = NEEDS.get(id)
		if (need !== undefined) node.needs = need
		const suppressed = parts.checksSuppressed.find((s) => s.check === id && matchesEntity(s.entity, name))
		if (suppressed !== undefined) node.because = suppressed.because
		const finding = parts.findings.find((f) => f.check === id && matchesEntity(f.entity, name))
		if (finding !== undefined) {
			node.summary = finding.summary
			node.verdict = finding.verdict
		}
		return node
	})

	const counts = { blocked: 0, failed: 0, held: 0, skipped: 0 }
	for (const node of nodes) counts[node.status] += 1

	const failedSet = new Set(nodes.filter((n) => n.status === "failed").map((n) => n.id))
	const roots = [...failedSet].filter(
		(id) => !CHECK_EDGES.some((e) => e.kind === "dependsOn" && e.to === id && failedSet.has(e.from)),
	)

	return { counts, identity, name, nodes, readSurface, roots }
}

function statusFor(entity: string, id: string, parts: MatrixParts): CellStatus {
	const finding = parts.findings.find(
		(f) => f.check === id && matchesEntity(f.entity, entity) && f.verdict !== "COVERAGE_GAP" && f.verdict !== "BLOCKED",
	)
	if (finding !== undefined) return "failed"
	if (parts.checksSuppressed.some((s) => s.check === id && matchesEntity(s.entity, entity))) return "blocked"
	if (parts.checksSkipped.some((s) => s.check === id && matchesEntity(s.entity, entity))) return "skipped"
	if (parts.checksRun.includes(id)) return "held"
	return "skipped"
}

function matchesEntity(value: string | undefined, entity: string): boolean {
	return value === undefined || value === entity
}

function invalidateLinks(model: SpecModel): InvalidateLink[] {
	const out: InvalidateLink[] = []
	for (const op of model.operations) {
		if (op.entity === null || op.invalidates.length === 0) continue
		for (const route of op.invalidates) {
			const target = model.byRoute.get(route)
			const toEntity = target?.entity ?? owningEntityFromRoute(route, model) ?? op.entity
			out.push({
				cross: toEntity !== op.entity,
				fromEntity: op.entity,
				fromOp: op.operationId,
				toEntity,
				toRoute: route,
			})
		}
	}
	return out
}

function owningEntityFromRoute(route: string, model: SpecModel): string | null {
	for (const entity of model.entities.values()) {
		if (entity.readSurface.includes(route)) return entity.name
	}
	return null
}

function assembleGraph(
	baseUrl: string,
	generatedAt: string,
	entities: EntityMatrix[],
	invalidate: InvalidateLink[],
): MatrixGraph {
	const counts = { blocked: 0, failed: 0, held: 0, skipped: 0 }
	for (const entity of entities) {
		counts.failed += entity.counts.failed
		counts.blocked += entity.counts.blocked
		counts.held += entity.counts.held
		counts.skipped += entity.counts.skipped
	}
	const cross = invalidate.filter((link) => link.cross)
	const names = entities.map((e) => e.name)
	const thesis = thesisFor(entities, cross)
	const rootList = entities.flatMap((e) => e.roots.map((id) => `${e.name}:${id}`))
	const who = names.length > 12 ? `${names.length} entities` : names.join(", ")
	const inbound: Record<string, number> = {}
	for (const link of cross) inbound[link.toEntity] = (inbound[link.toEntity] ?? 0) + 1
	const summary =
		`${who}: ${counts.failed} failed, ${counts.blocked} blocked, ${counts.held} held, ${counts.skipped} skipped.` +
		(cross.length > 8
			? ` ${unique(cross.map((l) => l.toEntity)).length} parents receive ${cross.length} cross-entity claims.`
			: cross.length > 0
				? ` Cross-entity invalidate: ${unique(cross.map((l) => `${l.fromEntity} → ${l.toEntity}`)).join(", ")}.`
				: " No cross-entity invalidate.") +
		(rootList.length > 0 && rootList.length <= 8 ? ` Roots: ${rootList.join(", ")}.` : "")

	return {
		kind: "oat.matrix",
		version: 2,
		read: {
			edges: {
				dependsOn: "if `from` failed, `to` is blocked. Do not treat blocked as a second defect.",
				invalidate:
					"a write on `fromEntity` is declared to change `toRoute` on `toEntity`. `cross` is the case the invalidation check probes.",
				uses: "`to` is a composition check (e.g. query.axes-compose) built from the single-axis check `from`.",
			},
			purpose:
				"How oat crossed the entities in this run. Each entity's checks are tracked independently. " +
				"`invalidate` edges are x-invalidate claims. failed = two projections of the same fact " +
				"disagreed. blocked = a dependsOn check already failed — not a second defect.",
			status: {
				blocked: "not evaluated; a dependsOn check already failed",
				failed: "two projections of the same fact disagreed — a finding",
				held: "tested, and the projections agreed",
				skipped: "the document does not support this check",
			},
		},
		summary,
		thesis,
		index: {
			crossClaims: cross.length,
			entityCount: entities.length,
			failed: entities.filter((e) => e.counts.failed > 0).map((e) => e.name),
			inbound,
			parents: unique(cross.map((l) => l.toEntity)),
		},
		baseUrl,
		generatedAt,
		counts,
		entities,
		invalidate,
		edges: CHECK_EDGES,
		mermaid: mermaidFromGraph(entities, invalidate),
	}
}

/** Drop per-check nodes for clean entities so a 2k-entity graph stays loadable. */
export function compactMatrixGraph(graph: MatrixGraph): MatrixGraph {
	if (graph.entities.length <= 80) return graph
	const cross = graph.invalidate.filter((l) => l.cross)
	return {
		...graph,
		edges: graph.edges.filter((e) => e.kind === "uses"),
		entities: graph.entities.map((entity) =>
			entity.counts.failed === 0 && entity.counts.blocked === 0 ? { ...entity, nodes: [] } : entity,
		),
		invalidate: unique(cross.map((l) => `${l.fromEntity}\0${l.toEntity}`)).map((key) => {
			const [fromEntity, toEntity] = key.split("\0") as [string, string]
			return {
				cross: true,
				fromEntity,
				fromOp: `${fromEntity}.create`,
				toEntity,
				toRoute: `GET …/${toEntity}`,
			}
		}),
	}
}

function thesisFor(entities: EntityMatrix[], cross: InvalidateLink[]): string {
	const failed = entities.filter((e) => e.counts.failed > 0)
	if (failed.length > 0) {
		const first = failed[0]
		if (first === undefined) return ""
		return `${first.name} had a check that disagreed. Composition checks that depend on it stood down — not extra defects.`
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

function unique(values: string[]): string[] {
	return [...new Set(values)]
}

function mermaidFromGraph(entities: EntityMatrix[], invalidate: InvalidateLink[]): string {
	const mid = (id: string): string => id.replaceAll(/[^A-Za-z0-9_]/g, "_")
	const lines = ["flowchart LR"]
	if (entities.length > 24) {
		const inbound = new Map<string, number>()
		for (const link of invalidate) {
			if (link.cross) inbound.set(link.toEntity, (inbound.get(link.toEntity) ?? 0) + 1)
		}
		for (const [parent, n] of [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)) {
			lines.push(`  ${mid(parent)}(("${parent} ← ${n}"))`)
		}
		lines.push(`  note["${entities.length} entities, compact"]`)
		return lines.join("\n")
	}
	for (const entity of entities) {
		lines.push(`  ${mid(entity.name)}((${entity.name}))`)
	}
	for (const link of invalidate.filter((l) => l.cross)) {
		lines.push(`  ${mid(link.fromEntity)} -->|invalidates| ${mid(link.toEntity)}`)
	}
	const focus = entities.find((e) => invalidate.some((l) => l.cross && l.fromEntity === e.name)) ?? entities[0]
	if (focus !== undefined) {
		const byId = new Map(focus.nodes.map((n) => [n.id, n]))
		for (const spec of NODE_ORDER) {
			const node = byId.get(spec.id)
			if (node === undefined) continue
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
			const dest = byId.get(edge.to)
			const arrow = dest?.status === "blocked" || dest?.status === "skipped" ? "-.->" : "-->"
			lines.push(`  ${mid(`${focus.name}__${edge.from}`)} ${arrow} ${mid(`${focus.name}__${edge.to}`)}`)
		}
	}
	lines.push("  classDef held stroke:#7dcea0")
	lines.push("  classDef failed stroke:#ff6b3d,color:#ff6b3d")
	lines.push("  classDef blocked stroke:#6d7686,stroke-dasharray: 4 4")
	lines.push("  classDef skipped stroke:#3d4758")
	return lines.join("\n")
}

function renderPoster(graph: MatrixGraph): string {
	const multi = graph.entities.length > 1
	const crowded = graph.entities.length > 24
	const focus =
		graph.entities.find((e) => graph.invalidate.some((l) => l.cross && l.fromEntity === e.name)) ?? graph.entities[0]
	const strips = focus === undefined || crowded ? "" : stripHtml(focus, multi)
	const loom = focus === undefined ? "" : loomSvg(focus)
	const surface = (focus?.readSurface ?? []).map((r) => `<code>${esc(r)}</code>`).join("<span> · </span>")

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oat matrix — ${esc(graph.entities.length <= 8 ? graph.entities.map((e) => e.name).join(", ") : `${graph.entities.length} entities`)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #243044;
    --ink: #f2ead8;
    --mute: #9aa3b2;
    --line: #4a5870;
    --held: #7dcea0;
    --fail: #ff6b3d;
    --block: #6d7686;
    --skip: #3d4758;
    --pin: #f0c14b;
    --card: #1b2332;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); }
  body { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; line-height: 1.45; }
  .poster { width: 1440px; margin: 0 auto; padding: 32px 44px 36px; }
  header {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 24px;
    align-items: end;
    border-bottom: 1px solid var(--line);
    padding-bottom: 16px;
  }
  .kicker { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--mute); }
  h1 {
    font-family: Syne, sans-serif;
    font-weight: 800;
    font-size: 38px;
    line-height: 0.95;
    letter-spacing: -0.03em;
    margin: 8px 0 10px;
  }
  .thesis { color: var(--ink); max-width: 44em; }
  .counts { display: grid; grid-template-columns: repeat(4, auto); gap: 18px 28px; text-align: right; }
  .counts b { display: block; font-family: Syne, sans-serif; font-size: 28px; font-weight: 700; }
  .counts span { color: var(--mute); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
  .counts .failed b { color: var(--fail); }
  .counts .blocked b { color: var(--block); }
  .counts .held b { color: var(--held); }
  .band, .stage, .cards { margin-top: 18px; background: var(--card); border: 1px solid var(--line); }
  .band-label, .stage-label {
    color: var(--mute);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 10px 16px 0;
  }
  svg { display: block; width: 100%; height: auto; }
  .legend {
    display: flex; gap: 22px; padding: 8px 16px 12px;
    color: var(--mute); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  }
  .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; }
  .swatch.held { background: var(--held); }
  .swatch.failed { background: var(--fail); }
  .swatch.blocked { background: var(--block); box-shadow: inset 0 0 0 1px #9aa3b2; }
  .swatch.skipped { background: var(--skip); }
  .forest { padding: 16px 20px 20px; }
  .forest-lead { color: var(--mute); margin: 0 0 14px; }
  .bar-row { display: grid; grid-template-columns: 80px 1fr 90px; gap: 12px; align-items: center; margin: 6px 0; }
  .bar-name { color: var(--pin); }
  .bar-track { height: 8px; background: #2c3546; }
  .bar-fill { height: 8px; background: #ff6b3d; }
  .bar-n { color: var(--mute); font-size: 11px; }
  .bar-more { color: var(--mute); margin-top: 8px; }
  .crowd-note { margin-top: 16px; color: var(--mute); }
  .cards { display: grid; grid-template-columns: repeat(${Math.min(Math.max(graph.entities.length, 1), 5)}, minmax(200px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .card { background: var(--card); padding: 14px 16px 16px; }
  .card h2 { font-family: Syne, sans-serif; font-size: 18px; margin: 0 0 6px; }
  .card .meta { color: var(--mute); font-size: 11px; margin-bottom: 10px; }
  .dots { display: flex; gap: 5px; flex-wrap: wrap; }
  .dot { width: 12px; height: 12px; border: 1px solid var(--line); }
  .dot.held { background: var(--held); border-color: #3f6b55; }
  .dot.failed { background: var(--fail); border-color: var(--fail); }
  .dot.blocked { background: transparent; border-style: dashed; border-color: var(--block); }
  .dot.skipped { background: var(--skip); }
  .strips { margin-top: 18px; display: grid; gap: 10px; }
  .strip { display: grid; grid-template-columns: 140px 1fr; gap: 12px; align-items: start; }
  .strip-title { color: var(--mute); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; padding-top: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 1px solid var(--line); padding: 3px 8px; color: var(--mute); }
  .chip.held { color: var(--held); border-color: #3f6b55; }
  .chip.failed { color: var(--fail); border-color: var(--fail); background: #3a221c; }
  .chip.blocked { color: var(--block); border-style: dashed; }
  .chip.skipped { opacity: 0.45; }
  footer {
    margin-top: 18px; color: var(--mute); font-size: 11px;
    display: flex; justify-content: space-between; gap: 16px;
    border-top: 1px solid var(--line); padding-top: 12px;
  }
  footer code { color: var(--ink); }
</style>
</head>
<body>
<article class="poster">
  <header>
    <div>
      <div class="kicker">${multi ? "many entities · invalidate is an edge" : "same fact · many checks"}</div>
      <h1>${headerTitle(graph)}</h1>
      <p class="thesis">${esc(graph.thesis)}</p>
    </div>
    <div class="counts">
      <div class="failed"><b>${graph.counts.failed}</b><span>disagreed</span></div>
      <div class="blocked"><b>${graph.counts.blocked}</b><span>blocked</span></div>
      <div class="held"><b>${graph.counts.held}</b><span>agreed</span></div>
      <div class="skipped"><b>${graph.counts.skipped}</b><span>did not apply</span></div>
    </div>
  </header>

  <div class="band">
    <div class="band-label">entities and x-invalidate</div>
    ${entityBand(graph)}
    <div class="legend">
      <span><i class="swatch held"></i>own read surface</span>
      <span><i class="swatch failed"></i>cross-entity invalidate — the check that needs two entities</span>
    </div>
  </div>

  ${multi && !crowded ? entityCards(graph) : ""}
  ${crowded ? forestSummary(graph) : ""}

  <div class="stage">
    <div class="stage-label">${focus === undefined ? "checks" : `checks — ${focus.name}`}</div>
    ${loom}
    <div class="legend">
      <span><i class="swatch held"></i>agreed</span>
      <span><i class="swatch failed"></i>disagreed — a finding</span>
      <span><i class="swatch blocked"></i>blocked — an earlier check it depends on already failed</span>
      <span><i class="swatch skipped"></i>did not apply — the document has no support for this check</span>
    </div>
  </div>

  <div class="strips">${strips}</div>

  <footer>
    <div>${surface === "" ? "" : `read surface ${surface}`}</div>
    <div>${esc(graph.baseUrl)} · ${esc(graph.generatedAt)}</div>
  </footer>
</article>
</body>
</html>
`
}

function headerTitle(graph: MatrixGraph): string {
	if (graph.entities.length <= 1) {
		const name = graph.entities[0]?.name ?? "entity"
		return `${esc(name)} was asked<br>through independent projections`
	}
	const cross = graph.invalidate.filter((l) => l.cross).length
	return `${graph.entities.length} entities, ${cross} cross-entity claim${cross === 1 ? "" : "s"}`
}

function entityBand(graph: MatrixGraph): string {
	if (graph.entities.length > 24) return crowdedBand(graph)
	const names = graph.entities.map((e) => e.name)
	const n = Math.max(names.length, 1)
	const width = 1120
	const perRow = n <= 6 ? n : n <= 12 ? Math.ceil(n / 2) : 5
	const rows = Math.ceil(n / perRow)
	const rowH = 96
	const top = 56
	const pos = new Map(
		names.map((name, i) => {
			const row = Math.floor(i / perRow)
			const col = i % perRow
			const inRow = Math.min(perRow, n - row * perRow)
			const slot = width / (inRow + 1)
			return [name, { x: slot * (col + 1), y: top + row * rowH }] as const
		}),
	)
	const height = Math.max(160, top + rows * rowH + 20)

	const pins = names.map((name) => {
		const at = pos.get(name)
		if (at === undefined) return ""
		const slice = graph.entities.find((e) => e.name === name)
		const fill = "#f0c14b"
		const surfaces = slice?.readSurface.length ?? 0
		return `<g>
      <circle cx="${at.x}" cy="${at.y}" r="16" fill="${fill}"/>
      <circle cx="${at.x}" cy="${at.y}" r="6" fill="#243044"/>
      <text x="${at.x}" y="${at.y + 36}" text-anchor="middle" fill="${fill}" font-size="14" font-family="Syne, sans-serif" font-weight="700">${esc(name)}</text>
      <text x="${at.x}" y="${at.y + 52}" text-anchor="middle" fill="#9aa3b2" font-size="10" font-family="IBM Plex Mono, monospace">${surfaces} read surface${surfaces === 1 ? "" : "s"}</text>
    </g>`
	})

	const pairs = new Map<string, { from: string; to: string }>()
	for (const link of graph.invalidate) {
		if (!link.cross) continue
		pairs.set(`${link.fromEntity}\0${link.toEntity}`, { from: link.fromEntity, to: link.toEntity })
	}
	const labelArrows = names.length <= 8
	const arrows = [...pairs.values()].map((link) => {
		const from = pos.get(link.from)
		const to = pos.get(link.to)
		if (from === undefined || to === undefined) return ""
		const midX = (from.x + to.x) / 2
		const lift = from.y === to.y ? 36 : Math.abs(to.y - from.y) / 2 + 16
		const midY = Math.min(from.y, to.y) - lift
		const label = labelArrows
			? `<text x="${midX}" y="${midY - 4}" text-anchor="middle" fill="#ff6b3d" font-size="11" font-family="IBM Plex Mono, monospace">${esc(`${link.from} → ${link.to}`)}</text>`
			: ""
		return `<path d="M ${from.x} ${from.y - 16} Q ${midX} ${midY}, ${to.x} ${to.y - 16}" fill="none" stroke="#ff6b3d" stroke-width="1.6" marker-end="url(#arrow-cross)"/>${label}`
	})

	const cross = graph.invalidate.filter((l) => l.cross)
	const empty =
		cross.length === 0
			? `<text x="560" y="36" text-anchor="middle" fill="#9aa3b2" font-size="12" font-family="IBM Plex Mono, monospace">${
					graph.invalidate.length === 0
						? "no x-invalidate edges in this document"
						: "invalidate stays on the same entity — the cross-entity check did not apply"
				}</text>`
			: ""

	return `<svg viewBox="0 0 1120 ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Entity invalidate graph">
    <defs>
      <marker id="arrow-cross" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#ff6b3d"/></marker>
      <marker id="arrow-self" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#6d7686"/></marker>
    </defs>
    ${empty}
    ${arrows.join("\n")}
    ${pins.join("\n")}
  </svg>`
}

function crowdedBand(graph: MatrixGraph): string {
	const inbound = new Map<string, string[]>()
	for (const link of graph.invalidate) {
		if (!link.cross) continue
		const list = inbound.get(link.toEntity) ?? []
		if (!list.includes(link.fromEntity)) list.push(link.fromEntity)
		inbound.set(link.toEntity, list)
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

function forestSummary(graph: MatrixGraph): string {
	const failed = graph.entities.filter((e) => e.counts.failed > 0)
	const blocked = graph.entities.filter((e) => e.counts.blocked > 0 && e.counts.failed === 0)
	const held = graph.entities.filter((e) => e.counts.failed === 0 && e.counts.blocked === 0)
	const cards = [...failed, ...blocked.slice(0, 8)].map((entity) => {
		const outbound = graph.invalidate.filter((l) => l.fromEntity === entity.name && l.cross)
		const inv =
			outbound.length === 0
				? "does not invalidate another entity"
				: `invalidates ${unique(outbound.map((l) => l.toEntity)).join(", ")}`
		return `<div class="card">
      <h2>${esc(entity.name)}</h2>
      <div class="meta">${entity.counts.failed} disagreed · ${entity.counts.blocked} stood down · ${esc(inv)}</div>
    </div>`
	})
	return `<div class="crowd-note">
    ${held.length} entities agreed on every check that applied.
    ${failed.length === 0 ? "Showing the detail view for one writer, not all 200 entities." : `Showing ${failed.length} entities that disagreed.`}
  </div>
  ${cards.length > 0 ? `<div class="cards">${cards.join("")}</div>` : ""}`
}

function entityCards(graph: MatrixGraph): string {
	const cards = graph.entities.map((entity) => {
		const outbound = graph.invalidate.filter((l) => l.fromEntity === entity.name && l.cross)
		const inv =
			outbound.length === 0
				? "does not invalidate another entity"
				: `invalidates ${unique(outbound.map((l) => l.toEntity)).join(", ")}`
		const loomDots = NODE_ORDER.map((spec) => {
			const status = entity.nodes.find((n) => n.id === spec.id)?.status ?? "skipped"
			return `<span class="dot ${status}" title="${esc(spec.label)}"></span>`
		}).join("")
		return `<div class="card">
      <h2>${esc(entity.name)}</h2>
      <div class="meta">${entity.identity === null ? "no identity" : `id ${esc(entity.name)}.${esc(entity.identity)}`} · ${entity.readSurface.length} surfaces · ${esc(inv)}</div>
      <div class="dots">${loomDots}</div>
    </div>`
	})
	return `<div class="cards">${cards.join("")}</div>`
}

function stripHtml(focus: EntityMatrix, multi: boolean): string {
	const interesting = (id: string, status: CellStatus): boolean => !multi || status === "failed" || status === "blocked"
	return STRIPS.map((strip) => {
		const chips = strip.ids
			.map((id) => {
				const node = focus.nodes.find((n) => n.id === id)
				const status = node?.status ?? "skipped"
				if (!interesting(id, status)) return ""
				const short = id.split(".").slice(1).join(".")
				const extra = node?.because
				const title = extra !== undefined ? `${id} — waiting on ${extra}` : id
				return `<span class="chip ${status}" title="${esc(title)}">${esc(short)}</span>`
			})
			.filter(Boolean)
			.join("")
		if (chips === "") return ""
		return `<div class="strip"><div class="strip-title">${esc(strip.title)}</div><div class="chips">${chips}</div></div>`
	}).join("")
}

function loomSvg(focus: EntityMatrix): string {
	const byId = new Map(focus.nodes.map((n) => [n.id, n]))
	const st = (id: string): CellStatus => byId.get(id)?.status ?? "skipped"

	const pin = { x: 130, y: 270 }
	const warp: Array<{ id: string; x: number; y: number }> = [
		{ id: "tenant.item-not-readable-cross-tenant", x: 130, y: 70 },
		{ id: "list.read-after-write", x: 130, y: 150 },
		{ id: "consistency.projections-agree", x: 130, y: 390 },
		{ id: "filter.equality-selects-exactly-one", x: 390, y: 90 },
		{ id: "sort.order-is-applied", x: 390, y: 180 },
		{ id: "select.projection-honoured", x: 390, y: 270 },
		{ id: "search.q-narrows-result", x: 390, y: 360 },
		{ id: "pagination.page-walk-covers-set", x: 390, y: 450 },
	]
	const weft: Array<{ id: string; x: number; y: number; from: string[] }> = [
		{
			from: ["filter.equality-selects-exactly-one", "sort.order-is-applied"],
			id: "query.axes-compose",
			x: 700,
			y: 110,
		},
		{
			from: ["filter.equality-selects-exactly-one", "select.projection-honoured"],
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

	const loc = new Map<string, { x: number; y: number }>()
	for (const node of warp) loc.set(node.id, node)
	for (const node of weft) loc.set(node.id, node)

	const lines: string[] = []
	for (const node of warp) {
		const surface = node.x < 200
		if (surface) lines.push(link(pin, node, st(node.id)))
		else lines.push(link(pin, node, st(node.id)))
	}
	for (const node of weft) {
		for (const src of node.from) {
			const from = loc.get(src)
			if (from !== undefined) lines.push(link(from, node, st(node.id)))
		}
	}

	const stations = [...warp, ...weft].map((pt) => {
		const spec = NODE_ORDER.find((s) => s.id === pt.id)
		const status = st(pt.id)
		return box(
			pt,
			spec?.label ?? pt.id,
			status === "failed" ? "disagreed" : status === "blocked" ? "" : (spec?.hint ?? ""),
			status,
		)
	})

	return `<svg viewBox="0 0 1120 540" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Query checks for ${esc(focus.name)}">
    <text x="48" y="24" fill="#9aa3b2" font-size="11" letter-spacing="2" font-family="IBM Plex Mono, monospace">READS</text>
    <text x="360" y="24" fill="#9aa3b2" font-size="11" letter-spacing="2" font-family="IBM Plex Mono, monospace">AXES</text>
    <text x="650" y="24" fill="#9aa3b2" font-size="11" letter-spacing="2" font-family="IBM Plex Mono, monospace">PAIRS</text>
    <text x="930" y="24" fill="#9aa3b2" font-size="11" letter-spacing="2" font-family="IBM Plex Mono, monospace">TRIPLES</text>
    ${lines.join("\n")}
    <circle cx="${pin.x}" cy="${pin.y}" r="18" fill="#f0c14b"/>
    <circle cx="${pin.x}" cy="${pin.y}" r="7" fill="#243044"/>
    <text x="${pin.x}" y="${pin.y + 38}" text-anchor="middle" fill="#f0c14b" font-size="13" font-family="Syne, sans-serif" font-weight="700">${esc(focus.name)}</text>
    <text x="${pin.x}" y="${pin.y + 54}" text-anchor="middle" fill="#9aa3b2" font-size="10" font-family="IBM Plex Mono, monospace">one cohort</text>
    ${stations.join("\n")}
  </svg>`
}

function link(from: { x: number; y: number }, to: { x: number; y: number }, status: CellStatus): string {
	const color =
		status === "failed" ? "#ff6b3d" : status === "held" ? "#7dcea0" : status === "blocked" ? "#6d7686" : "#3d4758"
	const dash = status === "blocked" || status === "skipped" ? 'stroke-dasharray="5 5"' : ""
	return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${color}" stroke-width="1.6" ${dash}/>`
}

function box(pt: { x: number; y: number }, label: string, caption: string, status: CellStatus): string {
	const stroke =
		status === "failed" ? "#ff6b3d" : status === "held" ? "#7dcea0" : status === "blocked" ? "#6d7686" : "#3d4758"
	const fill = status === "failed" ? "#ff6b3d" : "#1b2332"
	const ink = status === "failed" ? "#243044" : status === "held" ? "#7dcea0" : "#9aa3b2"
	const dash = status === "blocked" || status === "skipped" ? 'stroke-dasharray="3 3"' : ""
	const w = Math.max(92, label.length * 7.4 + 22)
	const x = pt.x - w / 2
	const y = pt.y - 15
	const cap =
		caption === ""
			? ""
			: `<text x="${pt.x}" y="${pt.y + 28}" text-anchor="middle" fill="#9aa3b2" font-size="10" font-family="IBM Plex Mono, monospace">${esc(caption)}</text>`
	return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="30" rx="2" fill="${fill}" stroke="${stroke}" ${dash}/>
    <text x="${pt.x}" y="${pt.y + 5}" text-anchor="middle" fill="${ink}" font-size="12" font-family="Syne, sans-serif" font-weight="700">${esc(label)}</text>
    ${cap}
  </g>`
}

function esc(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
