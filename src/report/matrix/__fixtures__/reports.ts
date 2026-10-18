import { checkCatalog } from "../catalog.ts"
import type { CellStatus, CheckRow, MatrixFinding, MatrixReport } from "../types.ts"

/* Reports built from a few lines: entities, who invalidates what, and the status of chosen cells. */

export interface EntitySpec {
	name: string
	readSurface?: string[]
	identity?: string | null
}

export interface ReportSpec {
	entities: Array<string | EntitySpec>
	/** Entities the run tested; every entity by default. */
	tested?: string[]
	/** `writer` declares that its writes change each of `routes`. */
	invalidates?: Array<{ writer: string | null; routes: string[]; op?: string }>
	/** Routes served by an operation of `entity`. */
	routes?: Record<string, string | null>
	/** Cell statuses by `entity` then check id; everything else ran and passed. */
	cells?: Record<string, Record<string, Exclude<CellStatus, "passed">>>
	findings?: MatrixFinding[]
	checksRun?: string[]
}

export function report(spec: ReportSpec): MatrixReport {
	const entities = spec.entities.map((e) => (typeof e === "string" ? { name: e } : e))
	const findings: MatrixFinding[] = [...(spec.findings ?? [])]
	const suppressed: Array<CheckRow & { because: string }> = []
	const skipped: Array<CheckRow & { needs: string }> = []
	const outOfScope: CheckRow[] = []
	for (const [entity, cells] of Object.entries(spec.cells ?? {})) {
		for (const [check, status] of Object.entries(cells)) {
			if (status === "failed") findings.push({ check, entity, summary: `${check} disagreed`, verdict: "BACKEND_BUG" })
			if (status === "blocked") suppressed.push({ because: "filter.equality-selects-exactly-one", check, entity })
			if (status === "skipped") skipped.push({ check, entity, needs: "support" })
			if (status === "out-of-scope") outOfScope.push({ check, entity })
		}
	}
	return {
		baseUrl: "http://api.test",
		checksOutOfScope: outOfScope,
		checksRun: spec.checksRun ?? [...checkCatalog().ids],
		checksSkipped: skipped,
		checksSuppressed: suppressed,
		entitiesTested: spec.tested ?? entities.map((e) => e.name),
		findings,
		model: {
			byRoute: new Map(Object.entries(spec.routes ?? {}).map(([route, entity]) => [route, { entity }])),
			entities: new Map(
				entities.map((e) => [
					e.name,
					{ identity: e.identity ?? null, name: e.name, readSurface: e.readSurface ?? [`GET /${e.name}`] },
				]),
			),
			operations: (spec.invalidates ?? []).map((claim, i) => ({
				entity: claim.writer,
				invalidates: claim.routes,
				operationId: claim.op ?? `${claim.writer ?? "free"}.op${i}`,
			})),
		},
		startedAt: new Date(Date.UTC(2026, 9, 18)),
	}
}

/** `n` entities `e0`…, each writing to the parent `parentOf` picks; `failing` of them disagree once. */
export function crowd(n: number, parentOf: (i: number) => number, failing: number[] = []): MatrixReport {
	const names = Array.from({ length: n }, (_, i) => `e${i}`)
	return report({
		cells: Object.fromEntries(failing.map((i) => [`e${i}`, { "list.read-after-write": "failed" }])),
		entities: names,
		invalidates: names.map((name, i) => ({ routes: [`GET /e${parentOf(i)}`], writer: name })),
	})
}
