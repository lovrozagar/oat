import { renderConfidenceMarkdown } from "../confidence.ts"
import { describeRequested } from "../../runtime/scope/plan.ts"
import {
	type OperationCoverage,
	type OperationStatus,
	type ScopeReport,
	type SupportUse,
} from "../../runtime/scope/types.ts"

const STATUS_MARK: Record<OperationStatus, string> = {
	blocked: "○",
	failed: "✗",
	passed: "✓",
	inconclusive: "?",
	untested: "○",
}

/** An operation by id, under its origin when it is not the primary's. */
function operationLabel(op: { origin?: string; operationId: string }): string {
	return op.origin === undefined ? op.operationId : `${op.origin}:${op.operationId}`
}

/** One line naming the scope: what was asked for, or that the run was full. */
export function scopeLine(scope: ScopeReport, dash: string): string {
	if (scope.mode === "full") {
		const graded = scope.operations.filter((op) => op.status !== "untested").length
		return `full${dash}${graded} of ${scope.operations.length} operations graded`
	}
	const n = scope.operations.length
	return `targeted${dash}${n} operation${n === 1 ? "" : "s"} (${describeRequested(scope.requested)})`
}

function operationRow(op: OperationCoverage): string {
	const failed = op.checks.failed.length === 0 ? "0" : `${op.checks.failed.length} (${op.checks.failed.join(", ")})`
	return (
		`| ${operationLabel(op)} | ${op.entity ?? "—"} | ${op.status} | ${op.sufficiency ?? ""} | ${op.checks.passed.length} | ${failed} | ` +
		`${op.checks.suppressed.length} | ${op.checks.inconclusive.length} | ${(op.why ?? op.reason ?? "").replace(/\|/g, "\\|")} |`
	)
}

function supportRow(use: SupportUse): string {
	const first =
		use.firstFailure === undefined
			? ""
			: `${use.firstFailure.status}${use.firstFailure.requestId === "" ? "" : ` (${use.firstFailure.requestId})`}`
	return `| ${operationLabel(use)} | ${use.calls} | ${use.non2xx} | ${first} |`
}

/** What a targeted run called without grading it. */
function supportSection(scope: ScopeReport): string[] {
	const lines = [
		"## Support operations",
		"",
		"> Called to reach or observe a target. Not graded: a defect here is out of this run's scope.",
		"",
	]
	if (scope.support.length === 0) {
		lines.push("None.")
	} else {
		lines.push("| operation | calls | non-2xx | first failure |")
		lines.push("| --- | --- | --- | --- |")
		for (const use of scope.support) lines.push(supportRow(use))
	}
	lines.push("")
	return lines
}

/** The markdown report's confidence summary and operation table. */
export function scopeSections(scope: ScopeReport): string[] {
	const lines = [renderConfidenceMarkdown(scope), "## Operations", ""]
	lines.push(
		scope.mode === "full"
			? "> Every operation in the document and whether any check graded it. `untested` names why not."
			: "> The targets of this run. Everything else oat called is listed under support: called, never graded.",
	)
	lines.push("")
	lines.push("| operation | entity | status | proof | passed | failed | suppressed | inconclusive | why |")
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
	for (const op of scope.operations) lines.push(operationRow(op))
	lines.push("")
	if (scope.originsSkipped.length > 0) {
		lines.push(`Origins not run — no target named them: ${scope.originsSkipped.join(", ")}.`)
		lines.push("")
	}
	if (scope.excluded.length > 0) {
		lines.push(`Excluded by the profile: ${scope.excluded.map((e) => `${e.operationId} (${e.reason})`).join(", ")}.`)
		lines.push("")
	}
	if (scope.mode === "targeted") lines.push(...supportSection(scope))
	return lines
}

function operationDetail(op: OperationCoverage): string {
	const graded = op.checks.passed.length + op.checks.failed.length + op.checks.inconclusive.length
	if (op.status === "failed") return `${graded} checks · ${op.findings} finding(s) (${op.checks.failed.join(", ")})`
	if (op.status === "passed" || op.status === "inconclusive") return `${graded} checks`
	return op.reason ?? ""
}

/** The console summary's scope line, and on a targeted run one line per target. */
export function scopeConsole(scope: ScopeReport): string[] {
	if (scope.mode === "full") return [`  scope: ${scopeLine(scope, " · ")}`]
	const lines = [`  scope: ${scopeLine(scope, " · ")} · ${scope.support.length} support op(s)`]
	const width = Math.max(16, ...scope.operations.map((op) => operationLabel(op).length)) + 2
	for (const op of scope.operations) {
		lines.push(
			`    ${STATUS_MARK[op.status]} ${operationLabel(op).padEnd(width)}${op.status.padEnd(14)}${operationDetail(op)}`,
		)
	}
	return lines
}
