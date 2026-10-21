/**
 * Teardown's lines in the console report: what was cleaned up, and every record left behind.
 */

import type { TeardownReport, UnidentifiedCreate } from "./types.ts"

export function renderTeardown(report: TeardownReport, created: number): string[] {
	const lines = renderUnidentified(report.unidentified)
	if (created === 0) return lines

	if (report.failed.length === 0 && report.unsupported.length === 0) {
		lines.push(`  cleaned up ${report.removed}/${created} created record(s)`)
		return [...lines, ...renderInferred(report.records)]
	}

	lines.push(`  cleanup: removed ${report.removed}/${created} created record(s)`)
	if (report.unsupported.length > 0) {
		lines.push(
			`    ${report.unsupported.join(", ")} — no delete operation in the document, so records ` +
				"created for these entities remain. Declare x-cleanup to make them removable.",
		)
	}
	for (const failure of report.failed.slice(0, 5)) {
		lines.push(`    ${failure.entity} ${failure.id} (as ${failure.principal}): ${failure.reason}`)
	}
	if (report.failed.length > 5) lines.push(`    … and ${report.failed.length - 5} more`)
	return [...lines, ...renderInferred(report.records)]
}

/* Each record ledgered from an answer rather than a declared create, so a reader can check it. */
function renderInferred(records: TeardownReport["records"]): string[] {
	const inferred = records.filter((record) => record.inferred === true)
	if (inferred.length === 0) return []
	return [
		`  inferred: ${inferred.length} record(s) ledgered from an answer that named a new id, not from a declared create`,
		...inferred.map(
			(record) =>
				`    ${record.entity} ${record.id} (as ${record.principal}): ${record.removed ? "removed" : "left in place"}`,
		),
	]
}

/* Each one a record oat made and cannot remove: listed by the request that made it. */
function renderUnidentified(unidentified: readonly UnidentifiedCreate[]): string[] {
	if (unidentified.length === 0) return []
	const lines = [
		`  leftovers: ${unidentified.length} create(s) answered 2xx but no id could be read; the record may remain`,
	]
	for (const create of unidentified.slice(0, 5)) {
		lines.push(`    ${create.operationId} ${create.method} ${create.url} → ${create.status} (#${create.seq})`)
	}
	if (unidentified.length > 5) lines.push(`    … and ${unidentified.length - 5} more`)
	return lines
}
