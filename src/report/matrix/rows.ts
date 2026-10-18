/**
 * Report rows looked up per cell. Each list is indexed once per graph by check id, then by entity,
 * rather than scanned for every cell of every entity.
 */

import type { CheckRow, MatrixFinding, MatrixReport, MatrixRows } from "./types.ts"

/** A list's rows by check id, then by entity key; `*` holds rows that name no entity. */
export type RowIndex<T> = ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<{ at: number; row: T }>>>

/** Every list of a report, indexed, and the set of checks that ran. */
export interface ReportRows {
	findings: RowIndex<MatrixFinding>
	suppressed: RowIndex<CheckRow & { because: string }>
	skipped: RowIndex<CheckRow>
	outOfScope: RowIndex<CheckRow>
	ran: ReadonlySet<string>
}

/** A report's lists as the matrix reads them: a list the report left out is empty. */
export function rowsOfReport(report: MatrixReport): Required<MatrixRows> {
	return {
		checksOutOfScope: report.checksOutOfScope ?? [],
		checksRun: report.checksRun,
		checksSkipped: report.checksSkipped ?? [],
		checksSuppressed: report.checksSuppressed ?? [],
		findings: report.findings,
	}
}

export function reportRows(rows: MatrixRows): ReportRows {
	return {
		findings: indexRows(rows.findings),
		outOfScope: indexRows(rows.checksOutOfScope ?? []),
		ran: new Set(rows.checksRun),
		skipped: indexRows(rows.checksSkipped),
		suppressed: indexRows(rows.checksSuppressed),
	}
}

/** The text before the first `separator`, or all of it. */
function head(value: string, separator: string): string {
	const at = value.indexOf(separator)
	return at === -1 ? value : value.slice(0, at)
}

/** The entity a report row is about: `table`, `table · fixture` and `table.field` are all `table`. */
function entityKey(value: string): string {
	return head(head(value, " · "), ".")
}

export function indexRows<T extends CheckRow>(rows: readonly T[]): RowIndex<T> {
	const index = new Map<string, Map<string, Array<{ at: number; row: T }>>>()
	for (const [at, row] of rows.entries()) {
		const byEntity = index.get(row.check) ?? new Map<string, Array<{ at: number; row: T }>>()
		index.set(row.check, byEntity)
		const key = row.entity === undefined ? "*" : entityKey(row.entity)
		const list = byEntity.get(key) ?? []
		list.push({ at, row })
		byEntity.set(key, list)
	}
	return index
}

/** The rows about `check` on `entity`, in report order. A row naming no entity applies to every entity. */
export function rowsFor<T extends CheckRow>(index: RowIndex<T>, check: string, entity: string): readonly T[] {
	const byEntity = index.get(check)
	if (byEntity === undefined) return []
	const own = byEntity.get(entityKey(entity)) ?? []
	const everyone = byEntity.get("*") ?? []
	const merged = everyone.length === 0 ? own : [...own, ...everyone].sort((a, b) => a.at - b.at)
	return merged.map((entry) => entry.row).filter((row) => matchesEntity(row.entity, entity))
}

/**
 * The matrix draws the primary document's entities. A secondary origin may have an entity of the
 * same name, and its findings belong to it, not to the primary one.
 */
export function onPrimary(finding: { origin?: string }): boolean {
	return finding.origin === undefined || finding.origin === ""
}

function matchesEntity(value: string | undefined, entity: string): boolean {
	if (value === undefined || value === entity) return true
	const lead = head(value, " · ")
	return lead === entity || lead.startsWith(`${entity}.`)
}
