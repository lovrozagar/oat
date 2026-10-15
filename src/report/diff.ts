/**
 * Two runs of one backend, compared.
 *
 * Root causes are matched by `findingKey`, so a defect two runs both found reads as persisting
 * though its ids and ports differ; operations are matched by id, so a target that passed before
 * and fails now stands out. Reports from other oat versions may lack fields: a missing `scope`
 * makes coverage not comparable rather than an error.
 */

import { isRootCause } from "../runtime/finding.ts"
import { findingKey } from "../runtime/finding-key.ts"

export interface SavedFinding {
	check: string
	entity: string
	detail: string
	summary: string
	verdict: string
	operations?: string[]
	origin?: string
}

export interface SavedReport {
	findings: SavedFinding[]
	scope?: { operations: Array<{ operationId?: string; status: string }> }
	targetVersion?: { value?: string; error?: string }
}

export interface RunDiff {
	new: SavedFinding[]
	fixed: SavedFinding[]
	persisting: SavedFinding[]
	/** Operations whose status changed; `null` when either report has no scope to compare. */
	coverage: Array<{ operationId: string; from: string; to: string }> | null
	versions: { a?: string; b?: string }
}

function byKey(report: SavedReport): Map<string, SavedFinding> {
	const keyed = new Map<string, SavedFinding>()
	for (const finding of report.findings) {
		if (!isRootCause(finding)) continue
		keyed.set(findingKey(finding), finding)
	}
	return keyed
}

function statuses(report: SavedReport): Map<string, string> | null {
	if (report.scope === undefined) return null
	return new Map(
		report.scope.operations.flatMap((op) => (op.operationId === undefined ? [] : [[op.operationId, op.status]])),
	)
}

function versionOf(report: SavedReport): string | undefined {
	return report.targetVersion?.value
}

function order(findings: SavedFinding[]): SavedFinding[] {
	return findings.sort((x, y) => x.check.localeCompare(y.check) || x.entity.localeCompare(y.entity))
}

export function diffReports(a: SavedReport, b: SavedReport): RunDiff {
	const before = byKey(a)
	const after = byKey(b)
	const statusA = statuses(a)
	const statusB = statuses(b)
	let coverage: RunDiff["coverage"] = null
	if (statusA !== null && statusB !== null) {
		coverage = [...new Set([...statusA.keys(), ...statusB.keys()])].sort().flatMap((operationId) => {
			const from = statusA.get(operationId) ?? "absent"
			const to = statusB.get(operationId) ?? "absent"
			return from === to ? [] : [{ from, operationId, to }]
		})
	}
	const versionA = versionOf(a)
	const versionB = versionOf(b)
	return {
		coverage,
		fixed: order([...before].filter(([key]) => !after.has(key)).map(([, finding]) => finding)),
		new: order([...after].filter(([key]) => !before.has(key)).map(([, finding]) => finding)),
		persisting: order([...after].filter(([key]) => before.has(key)).map(([, finding]) => finding)),
		versions: {
			...(versionA === undefined ? {} : { a: versionA }),
			...(versionB === undefined ? {} : { b: versionB }),
		},
	}
}

export function renderDiff(diff: RunDiff): string {
	const lines: string[] = [""]
	if (diff.versions.a !== undefined || diff.versions.b !== undefined) {
		lines.push(`  target  ${diff.versions.a ?? "?"} → ${diff.versions.b ?? "?"}`)
	}
	lines.push(`  ${diff.new.length} new · ${diff.fixed.length} fixed · ${diff.persisting.length} persisting`)
	const section = (title: string, findings: SavedFinding[]): void => {
		if (findings.length === 0) return
		lines.push("", `  ${title}`)
		for (const finding of findings) lines.push(`    ${finding.check.padEnd(40)} ${finding.entity} — ${finding.summary}`)
	}
	section("NEW", diff.new)
	section("FIXED", diff.fixed)
	section("PERSISTING", diff.persisting)
	if (diff.coverage === null) {
		lines.push("", "  coverage not comparable: a report has no scope")
	} else if (diff.coverage.length > 0) {
		lines.push("", "  COVERAGE")
		for (const change of diff.coverage) lines.push(`    ${change.operationId.padEnd(40)} ${change.from} → ${change.to}`)
	}
	lines.push("")
	return `${lines.join("\n")}\n`
}
