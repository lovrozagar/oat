/**
 * The run as a GitHub Actions job summary, in GitHub-flavored Markdown: the verdict and its exit
 * code, the operations by status, the root causes, and what went untested, collapsed. The CLI
 * appends it to the file `GITHUB_STEP_SUMMARY` names; this module never reads the environment.
 *
 * GitHub refuses a step's summary over 1 MiB, and other steps in a job write there too, so this one
 * stays within 64 KiB: rows are dropped from the end of the untested list, then of the findings,
 * each list saying how many it left out, and only then is the rest cut at a line boundary.
 */

import { EXIT, runVerdict } from "../../runtime/exit.ts"
import { type Finding, isFailingRootCause, isRootCause } from "../../runtime/finding.ts"
import type { Redactor } from "../../security/redact.ts"
import { coverageByCheck } from "./coverage.ts"
import type { ReportInput } from "./input.ts"
import { byVerdict, findingSubject } from "./verdicts.ts"

/** The most this summary writes, in UTF-8 bytes. */
export const STEP_SUMMARY_LIMIT = 65_536

const STATUSES = ["passed", "failed", "inconclusive", "blocked", "untested"] as const

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8")
}

/* One line of Markdown from text a backend or a check wrote: no secret, no raw markup, no line break. */
function inline(value: string, redactor: Redactor): string {
	return redactor
		.text(value)
		.replace(/\r\n|\r|\n/g, " ")
		.replaceAll("<", "&lt;")
}

/* A table cell: one line, and a pipe that does not end the cell. */
function cell(value: string, redactor: Redactor): string {
	return inline(value, redactor).replaceAll("|", "\\|")
}

function headOf(input: ReportInput): string[] {
	const { outcome, reason } = runVerdict(input)
	const redactor = input.client.redactor
	const lines = [
		`## oat: ${outcome} (exit ${EXIT[outcome]})`,
		"",
		`\`${inline(input.baseUrl, redactor)}\` · profile ${input.profile ?? "full"} · ` +
			`${input.checksRun.length} checks · ${input.entitiesTested.length} entities · ` +
			`${input.client.transcript.length} requests · ${(input.durationMs / 1000).toFixed(1)}s`,
		"",
		`**${inline(reason, redactor)}**`,
	]
	const known = input.findings.filter((finding) => finding.known !== undefined).length
	const fixed = input.baseline?.fixed.length ?? 0
	if (known > 0 || fixed > 0) lines.push("", `Baseline: ${known} known · ${fixed} fixed`)
	if (input.interrupted === true) lines.push("", "Interrupted by a signal: what ran before it is reported.")
	const operations = input.scope?.operations ?? []
	const counts = STATUSES.map((status) => operations.filter((op) => op.status === status).length)
	lines.push(
		"",
		`| operations | ${STATUSES.join(" | ")} |`,
		`|${" ---: |".repeat(STATUSES.length + 1)}`,
		`| ${operations.length} | ${counts.join(" | ")} |`,
		"",
	)
	return lines
}

/* Failing root causes, most severe first, then the known ones. */
function findingRows(input: ReportInput): string[] {
	const redactor = input.client.redactor
	const roots = input.findings.filter(isRootCause)
	const ordered = [
		...byVerdict(roots.filter(isFailingRootCause)),
		...byVerdict(roots.filter((finding) => !isFailingRootCause(finding))),
	].flatMap(([, group]) => group)
	return ordered.map(
		(finding: Finding) =>
			`| ${finding.verdict}${finding.known === undefined ? "" : " (known)"} | ${cell(findingSubject(finding), redactor)}` +
			` | \`${cell(finding.check, redactor)}\` | ${cell(finding.summary, redactor)} |`,
	)
}

/* Checks blocked by an earlier failure, then those that could not conclude, as the console groups them. */
function untestedRows(input: ReportInput): string[] {
	const redactor = input.client.redactor
	const suppressed = input.checksSuppressed ?? []
	/* Every blocked row came from a suppression, so one is there. */
	const waiting = (check: string): string =>
		inline((suppressed.find((s) => s.check === check) as { because: string }).because, redactor)
	const rows = coverageByCheck(input).blocked.map((row) =>
		row.ran === 0
			? `- \`${row.check}\`: blocked by an earlier failure, waiting on ${waiting(row.check)}`
			: `- \`${row.check}\`: blocked on ${row.blocked} of ${input.entitiesTested.length} entities, waiting on ${waiting(row.check)}`,
	)
	const byCheck = new Map<string, string>()
	for (const entry of input.inconclusive ?? []) byCheck.set(entry.check, entry.reason)
	for (const [check, reason] of [...byCheck].sort())
		rows.push(`- \`${check}\`: could not conclude: ${inline(reason, redactor)}`)
	return rows
}

interface Parts {
	head: string[]
	findings: string[]
	untested: string[]
	gapLine: string | null
	runDir: string
}

function rendered(parts: Parts, shownFindings: number, shownUntested: number): string {
	const { findings, untested, runDir } = parts
	const more = (n: number): string => `… and ${n} more, truncated, see ${runDir}`
	const lines = [...parts.head, "### Findings", ""]
	if (findings.length === 0) lines.push("No defects found.", "")
	else {
		lines.push(
			"| verdict | subject | check | summary |",
			"| --- | --- | --- | --- |",
			...findings.slice(0, shownFindings),
			"",
		)
		if (shownFindings < findings.length) lines.push(more(findings.length - shownFindings), "")
	}
	if (parts.gapLine !== null) lines.push(parts.gapLine, "")
	if (untested.length > 0) {
		lines.push(`<details><summary>Untested (${untested.length})</summary>`, "")
		if (shownUntested < untested.length) lines.push(`- ${more(untested.length - shownUntested)}`)
		lines.push(...untested.slice(0, shownUntested), "", "</details>", "")
	}
	lines.push(`Full report: \`${runDir}/oat-report.md\``)
	return `${lines.join("\n")}\n`
}

function fits(text: string): boolean {
	return bytes(text) <= STEP_SUMMARY_LIMIT
}

/* The largest count in [0, max] for which `holds` holds, given that it holds at 0. */
function largest(max: number, holds: (n: number) => boolean): number {
	let low = 0
	let high = max
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (holds(mid)) low = mid
		else high = mid - 1
	}
	return low
}

/* The first lines that fit, then a line that says where the rest is. */
function cut(text: string, runDir: string): string {
	const tail = `… truncated, see ${runDir}\n`
	let budget = STEP_SUMMARY_LIMIT - bytes(tail)
	const kept: string[] = []
	for (const line of text.split("\n")) {
		budget -= bytes(line) + 1
		if (budget < 0) break
		kept.push(line)
	}
	return `${kept.join("\n")}\n${tail}`
}

/** The run's job summary, at most {@link STEP_SUMMARY_LIMIT} bytes. */
export function renderStepSummary(input: ReportInput, where: { runDir: string }): string {
	const gaps = input.findings.filter((finding) => finding.verdict === "COVERAGE_GAP").length
	const blocked = input.findings.filter((finding) => finding.verdict === "BLOCKED").length
	const parts: Parts = {
		findings: findingRows(input),
		gapLine: gaps + blocked === 0 ? null : `${gaps} coverage gaps · ${blocked} blocked, listed in oat-report.md`,
		head: headOf(input),
		runDir: where.runDir,
		untested: untestedRows(input),
	}
	const whole = rendered(parts, parts.findings.length, parts.untested.length)
	if (fits(whole)) return whole
	const untested = largest(parts.untested.length, (n) => fits(rendered(parts, parts.findings.length, n)))
	if (untested > 0) return rendered(parts, parts.findings.length, untested)
	const findings = largest(parts.findings.length, (n) => fits(rendered(parts, n, 0)))
	const shortest = rendered(parts, findings, 0)
	return fits(shortest) ? shortest : cut(shortest, where.runDir)
}
