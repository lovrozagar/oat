/**
 * The shapes of the run's matrix: the poster's per-entity view, the machine graph, and what the
 * matrix reads of a report.
 */

import type { REPORT_SCHEMA_VERSION } from "../render/json.ts"

/** `out-of-scope`: a targeted run (`--ops`) did not ask for it — it could apply, it was not graded. */
export type CellStatus = "passed" | "failed" | "blocked" | "skipped" | "out-of-scope"
export type MatrixLayer = "axis" | "composition" | "surface" | "auth" | "schema" | "spec"

export interface MatrixView {
	entity: string
	baseUrl: string
	generatedAt: string
	readSurface: string[]
	failed: number
	blocked: number
	passed: number
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
	counts: Record<CellStatus, number>
	roots: string[]
	nodes: MatrixGraphNode[]
}

export interface MatrixGraph {
	kind: "oat.matrix"
	/** The same version `oat-report.json` states. */
	schemaVersion: typeof REPORT_SCHEMA_VERSION
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
	counts: Record<CellStatus, number>
	entities: EntityMatrix[]
	invalidate: InvalidateLink[]
	edges: MatrixGraphEdge[]
	mermaid: string
}

/** A report row about one check, on one entity or (naming none) on every entity. */
export interface CheckRow {
	check: string
	entity?: string
}

export interface MatrixFinding extends CheckRow {
	verdict: string
	summary: string
	detail?: string
	/** Set on a finding from a secondary origin. */
	origin?: string
}

/** The report lists the matrix reads: what ran, what stood down, what was found. */
export interface MatrixRows {
	checksRun: readonly string[]
	checksSkipped: ReadonlyArray<CheckRow & { needs: string }>
	checksSuppressed: ReadonlyArray<CheckRow & { because: string }>
	checksOutOfScope?: readonly CheckRow[]
	findings: readonly MatrixFinding[]
}

/** One entity's matrix, given piece by piece. */
export interface MatrixParts extends MatrixRows {
	entity: string
	baseUrl: string
	generatedAt: string
	readSurface: string[]
}

/** What the matrix reads of the document's model: `SpecModel` satisfies it. */
export interface MatrixModel {
	entities: ReadonlyMap<string, { name: string; identity: string | null; readSurface: string[] }>
	operations: ReadonlyArray<{ operationId: string; entity: string | null; invalidates: readonly string[] }>
	byRoute: ReadonlyMap<string, { entity: string | null }>
}

/** What the matrix reads of a run's report: `ReportInput` satisfies it. */
export interface MatrixReport {
	baseUrl: string
	startedAt: Date
	entitiesTested: readonly string[]
	checksRun: readonly string[]
	checksSkipped?: MatrixRows["checksSkipped"]
	checksSuppressed?: MatrixRows["checksSuppressed"]
	checksOutOfScope?: readonly CheckRow[]
	findings: readonly MatrixFinding[]
	model: MatrixModel
}

/** A point on a poster drawing. */
export interface Point {
	x: number
	y: number
}
