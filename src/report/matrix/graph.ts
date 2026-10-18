/**
 * The machine graph of a run's matrix: every entity's slice, the `x-invalidate` links between
 * entities, the check edges, and how to read them.
 */

import { type CheckCatalog, checkCatalog } from "./catalog.ts"
import { invalidateLinks } from "./invalidate.ts"
import { mermaidFromGraph } from "./mermaid.ts"
import { reportRows, rowsOfReport } from "./rows.ts"
import { entitySlice, type SliceEntity } from "./slice.ts"
import { summaryLine, thesisFor, totalCounts } from "./summary.ts"
import { unique } from "./text.ts"
import type { EntityMatrix, InvalidateLink, MatrixGraph, MatrixModel, MatrixParts, MatrixReport } from "./types.ts"

const READ: MatrixGraph["read"] = {
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
		passed: "tested, and the projections agreed",
		"out-of-scope": "a targeted run (--ops) did not grade it; it could apply",
		skipped: "the document does not support this check",
	},
}

/** Where and when the run happened. */
interface Origin {
	baseUrl: string
	generatedAt: string
}

/* What the graph shows: each entity's slice, and the invalidation links between them. */
interface MatrixContent {
	entities: EntityMatrix[]
	invalidate: InvalidateLink[]
}

/** One entity's graph, given piece by piece. */
export function buildMatrixGraph(parts: MatrixParts): MatrixGraph {
	const catalog = checkCatalog()
	const entity = { identity: null, name: parts.entity, readSurface: parts.readSurface }
	return assembleGraph(parts, { entities: [entitySlice(entity, catalog, reportRows(parts))], invalidate: [] }, catalog)
}

/** Every entity the run tested; a report that tested none draws one placeholder `entity`. */
export function buildMatrixGraphFromReport(input: MatrixReport): MatrixGraph {
	const catalog = checkCatalog()
	const rows = reportRows(rowsOfReport(input))
	const names = input.entitiesTested.length > 0 ? input.entitiesTested : ["entity"]
	const entities = names.map((name) => entitySlice(sliceEntity(input.model, name), catalog, rows))
	const origin = { baseUrl: input.baseUrl, generatedAt: input.startedAt.toISOString() }
	return assembleGraph(origin, { entities, invalidate: invalidateLinks(input.model) }, catalog)
}

function sliceEntity(model: MatrixModel, name: string): SliceEntity {
	const modelEntity = model.entities.get(name)
	return { identity: modelEntity?.identity ?? null, name, readSurface: modelEntity?.readSurface ?? [] }
}

function assembleGraph(origin: Origin, { entities, invalidate }: MatrixContent, catalog: CheckCatalog): MatrixGraph {
	const counts = totalCounts(entities)
	const cross = invalidate.filter((invalidation) => invalidation.cross)
	const inbound: Record<string, number> = {}
	for (const invalidation of cross) inbound[invalidation.toEntity] = (inbound[invalidation.toEntity] ?? 0) + 1
	return {
		kind: "oat.matrix",
		version: 2,
		read: READ,
		summary: summaryLine(entities, counts, cross),
		thesis: thesisFor(entities, cross),
		index: {
			crossClaims: cross.length,
			entityCount: entities.length,
			failed: entities.filter((e) => e.counts.failed > 0).map((e) => e.name),
			inbound,
			parents: unique(cross.map((l) => l.toEntity)),
		},
		baseUrl: origin.baseUrl,
		generatedAt: origin.generatedAt,
		counts,
		entities,
		invalidate,
		edges: catalog.edges,
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

/** The graph as the run folder's `matrix.json`: compacted, two-space indented, newline-terminated. */
export function graphJson(graph: MatrixGraph): string {
	return `${JSON.stringify(compactMatrixGraph(graph), null, 2)}\n`
}

export function renderMatrixGraph(input: MatrixReport): string {
	return graphJson(buildMatrixGraphFromReport(input))
}

export function renderMatrixGraphFromParts(parts: MatrixParts): string {
	return graphJson(buildMatrixGraph(parts))
}
