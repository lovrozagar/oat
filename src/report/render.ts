/**
 * Report rendering.
 *
 * The previous generation of this tool produced 88 failures that a human then spent days sorting
 * into five root causes by hand, and the artifact that team actually used was a set of
 * hand-written curl scripts. So: group by root cause, lead with severity, and generate the
 * reproducers.
 */

import { describeRequestBody, toCurl } from "../runtime/client.ts"
import { redactJson, redactUrl } from "../runtime/redact.ts"
import type { Client, Exchange } from "../runtime/client.ts"
import { describeRequested, type OperationCoverage, type OperationStatus, type ScopeReport } from "../runtime/scope.ts"
import { type Finding, isRootCause, type Verdict } from "../runtime/finding.ts"
import type { SpecModel } from "../spec/graph.ts"
import type { CheckTiming } from "../runtime/run.ts"

export interface ReportInput {
	findings: Finding[]
	model: SpecModel
	client: Client
	baseUrl: string
	entitiesTested: string[]
	checksRun: string[]
	checksSkipped?: Array<{ check: string; entity: string; needs: string }>
	/** Checks not run because a check they depend on was already reported broken. */
	checksSuppressed?: Array<{ check: string; entity: string; because: string }>
	/** Checks a targeted run did not run on an entity because none of their subjects is a target. */
	checksOutOfScope?: Array<{ check: string; entity: string }>
	/** What the run graded, per operation. */
	scope?: ScopeReport
	/** Checks that ran but could not reach a verdict, with the reason they stopped. */
	inconclusive?: Array<{ check: string; entity: string; reason: string }>
	/** Active profile's name — `"full"` unless `--profile` / `config.profile` said otherwise. */
	profile?: string
	/** Operations a profile excluded, and why. Silently narrowing coverage is the failure to avoid. */
	profileExclusions?: Array<{ entity: string; operationId: string; reason: string }>
	startedAt: Date
	durationMs: number
	/** Journal size when exchanges were persisted next to this report. */
	exchanges?: { count: number }
	/** How long each check took on each entity. */
	checkTimings?: CheckTiming[]
	/** What passing checks observed about policies the document leaves open. */
	checkNotes?: Array<{ check: string; entity: string; note: string }>
	network?: {
		kind: string
		attempts: number
		waitedMs: number
		incomplete: boolean
		url: string
	}
}

const VERDICT_ORDER: Verdict[] = ["SECURITY", "BACKEND_BUG", "SPEC_BUG", "AMBIGUITY", "BLOCKED", "COVERAGE_GAP"]

const VERDICT_LABEL: Record<Verdict, string> = {
	AMBIGUITY: "Ambiguous contract",
	BACKEND_BUG: "Backend defects",
	BLOCKED: "Blocked",
	COVERAGE_GAP: "Coverage gaps",
	SECURITY: "Security",
	SPEC_BUG: "Specification drift",
}

const VERDICT_NOTE: Record<Verdict, string> = {
	AMBIGUITY: "The document permits both the observed and the expected behaviour. Tighten it.",
	BACKEND_BUG: "Independent projections of the same fact disagree, or a property does not hold.",
	BLOCKED: "Not evaluated because something it depends on failed. Fix the cause first.",
	COVERAGE_GAP: "oat could not test this. Each entry names what would make it testable.",
	SECURITY: "Reachable across a tenant boundary. Treat as exploitable until proven otherwise.",
	SPEC_BUG: "The backend is defensible; the document disagrees. Generated clients will break.",
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60)
}

function truncate(value: unknown, max = 600): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
	if (text === undefined) return "—"
	return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text
}

function exchangeBlock(exchange: Exchange): string[] {
	const lines: string[] = []
	lines.push("")
	lines.push(
		`\`${exchange.method} ${new URL(redactUrl(exchange.url)).pathname}${new URL(redactUrl(exchange.url)).search}\` → **${exchange.status}** (${new Date(exchange.at).toISOString()} · ${exchange.durationMs}ms · ${formatBytes(exchange.requestBytes)} → ${formatBytes(exchange.responseBytes)}${exchange.requestId === "" ? "" : ` · ${exchange.requestId}`})`,
	)
	if (exchange.requestBody !== undefined) {
		lines.push("")
		lines.push("<details><summary>request body</summary>")
		lines.push("")
		lines.push("```json")
		lines.push(truncate(redactJson(describeRequestBody(exchange.requestBody))))
		lines.push("```")
		lines.push("")
		lines.push("</details>")
	}
	if (exchange.responseBody !== null && exchange.responseBody !== undefined) {
		lines.push("")
		lines.push("<details><summary>response body</summary>")
		lines.push("")
		lines.push("```json")
		lines.push(truncate(redactJson(exchange.responseBody)))
		lines.push("```")
		lines.push("")
		lines.push("</details>")
	}
	return lines
}

export function renderMarkdown(input: ReportInput): string {
	const { findings } = input
	const real = findings.filter(isRootCause)
	const lines: string[] = []
	const coverage = coverageByCheck(input)

	lines.push("# oat report")
	lines.push("")
	lines.push(`- **Backend**: ${input.baseUrl}`)
	lines.push(`- **Generated**: ${input.startedAt.toISOString()} (${(input.durationMs / 1000).toFixed(1)}s)`)
	if (input.scope !== undefined) lines.push(`- **Scope**: ${scopeLine(input.scope, " — ")}`)
	lines.push(`- **Entities tested**: ${entityList(input.entitiesTested)}`)
	lines.push(`- **Checks run**: ${input.checksRun.length}`)
	if (coverage.never.length > 0) {
		lines.push(`- **Checks that did not apply anywhere**: ${coverage.never.length}`)
	}
	if (coverage.partialSkip.length > 0) {
		lines.push(`- **Checks that applied only on some entities**: ${coverage.partialSkip.length}`)
	}
	const suppressedEverywhere = coverage.blocked.filter((row) => row.ran === 0)
	if (suppressedEverywhere.length > 0) {
		lines.push(`- **Checks blocked by an earlier failure**: ${suppressedEverywhere.length}`)
	}
	const unresolvedCount = new Set((input.inconclusive ?? []).map((s) => s.check)).size
	if (unresolvedCount > 0) lines.push(`- **Checks that could not conclude**: ${unresolvedCount}`)
	const profileLine = profileExclusionSummary(input)
	if (profileLine !== null) lines.push(`- **Profile**: ${profileLine}`)
	lines.push(
		`- **Requests**: ${input.client.transcript.length}` +
			` (${formatBytes(utf8Total(input.client.transcript, "request"))} req · ${formatBytes(utf8Total(input.client.transcript, "response"))} res)`,
	)
	if (input.exchanges !== undefined) {
		lines.push(`- **Exchanges**: ${input.exchanges.count} → [exchanges/](./exchanges/)`)
	}
	if (input.network !== undefined) {
		const wait = input.network.waitedMs > 0 ? ` · waited ${Math.round(input.network.waitedMs / 1000)}s` : ""
		lines.push(
			`- **Network**: ${input.network.kind} after ${input.network.attempts} attempt(s)${wait}` +
				(input.network.incomplete ? " — run incomplete, not a backend defect" : ""),
		)
	}
	lines.push("- **Matrix**: [matrix.html](./matrix.html) · [matrix.json](./matrix.json)")
	const timing = latency(input.client.transcript)
	if (timing !== null) {
		lines.push(
			`- **Latency**: p50 ${timing.p50}ms · p95 ${timing.p95}ms · max ${timing.max}ms ` +
				`(${timing.slowest.method} ${timing.slowest.path})`,
		)
	}
	const cost = costByCheck(input).slice(0, COST_ROWS)
	if (cost.length > 0) {
		lines.push(
			`- **Costliest checks**: ${cost.map((row) => `${row.check} ${row.requests} req · ${(row.ms / 1000).toFixed(1)}s`).join(", ")}`,
		)
	}
	lines.push("")

	/* Policies the document leaves open, as the backend showed them. One line per policy: the
	 * same observation on every entity is said once. */
	const observed = new Map<string, string[]>()
	for (const note of input.checkNotes ?? []) {
		observed.set(note.note, [...(observed.get(note.note) ?? []), note.entity])
	}
	if (observed.size > 0) {
		lines.push("## Observed behaviour")
		lines.push("")
		for (const [note, entities] of observed) lines.push(`- ${note} (${entities.join(", ")})`)
		lines.push("")
	}

	if (real.length === 0) {
		lines.push(`No defects found across ${input.checksRun.length} checks.`)
		lines.push("")
	} else {
		lines.push("## Summary")
		lines.push("")
		lines.push("| severity | count |")
		lines.push("| --- | --- |")
		for (const verdict of VERDICT_ORDER) {
			const group = findings.filter((f) => f.verdict === verdict)
			if (group.length === 0) continue
			lines.push(`| ${VERDICT_LABEL[verdict]} | ${group.length} |`)
		}
		lines.push("")
	}

	if (input.scope !== undefined) lines.push(...scopeSections(input.scope))

	for (const verdict of VERDICT_ORDER) {
		const group = findings.filter((f) => f.verdict === verdict)
		if (group.length === 0) continue

		lines.push(`## ${VERDICT_LABEL[verdict]}`)
		lines.push("")
		lines.push(`> ${VERDICT_NOTE[verdict]}`)
		lines.push("")

		for (const finding of group) {
			const entityLabel =
				finding.origin === undefined || finding.origin === "" ? finding.entity : `${finding.origin}/${finding.entity}`
			const subject =
				finding.fixture !== undefined && finding.fixture !== "" && !entityLabel.includes(" · ")
					? `${entityLabel} · ${finding.fixture}`
					: entityLabel
			lines.push(`### ${subject} — ${finding.summary}`)
			lines.push("")
			lines.push(`\`${finding.check}\``)
			lines.push("")
			lines.push(finding.detail)
			for (const exchange of finding.evidence.slice(0, 3)) {
				lines.push(...exchangeBlock(exchange))
			}
			if (finding.evidence.length > 0) {
				lines.push("")
				lines.push(`Reproduce: \`${ISSUE_REPRO_DIR}/${slug(`${finding.entity}-${finding.check}`)}.sh\``)
			}
			lines.push("")
		}
	}

	if (coverage.never.length > 0) {
		lines.push("## Did not apply anywhere")
		lines.push("")
		for (const row of coverage.never) {
			lines.push(`- \`${row.check}\` — ${row.needs} (all ${row.skipped} entities)`)
		}
		lines.push("")
	}
	if (coverage.partialSkip.length > 0) {
		lines.push("## Applied only on some entities")
		lines.push("")
		for (const row of coverage.partialSkip) {
			lines.push(`- \`${row.check}\` — ran on ${row.ran}, skipped on ${row.skipped} (${named(row.skippedEntities)})`)
		}
		lines.push("")
	}

	return `${lines.join("\n")}\n`
}

export interface ReproScript {
	filename: string
	content: string
}

/** Directory for curl scripts that replay a finding. Absent when the run is clean. */
export const ISSUE_REPRO_DIR = "issue-repro"

/** One runnable script per finding — the artifact a backend developer actually opens. */
export function renderRepros(findings: Finding[], baseUrl: string): ReproScript[] {
	/* `BASE` stands for the whole base URL, path prefix and all, so it replaces exactly that. */
	const base = baseUrl.replace(/\/+$/, "")
	const taken = new Set<string>()
	return findings
		.filter((finding) => finding.evidence.length > 0)
		.map((finding) => {
			const lines: string[] = []
			lines.push("#!/usr/bin/env bash")
			lines.push("# Generated by oat. Set TOKEN to a valid credential before running.")
			lines.push("#")
			lines.push(`# ${finding.entity} — ${finding.summary}`)
			for (const chunk of wrap(finding.detail, 88)) lines.push(`# ${chunk}`)
			lines.push("")
			lines.push("set -u")
			lines.push(`BASE="\${BASE:-${base}}"`)
			lines.push('TOKEN="${TOKEN:?set TOKEN to a valid credential}"')
			lines.push("")

			finding.evidence.forEach((exchange, index) => {
				lines.push(`# step ${index + 1} — observed ${exchange.status}`)
				lines.push(toCurl(exchange, { origin: base }))
				lines.push("")
			})

			/* One check can report more than once on an entity; each finding keeps its own file. */
			const stem = slug(`${finding.entity}-${finding.check}`)
			let filename = `${stem}.sh`
			for (let n = 2; taken.has(filename); n++) filename = `${stem}-${n}.sh`
			taken.add(filename)
			return {
				content: `${lines.join("\n")}\n`,
				filename,
			}
		})
}

function wrap(text: string, width: number): string[] {
	const words = text.split(/\s+/)
	const lines: string[] = []
	let current = ""
	for (const word of words) {
		if (current.length + word.length + 1 > width) {
			lines.push(current)
			current = word
		} else {
			current = current === "" ? word : `${current} ${word}`
		}
	}
	if (current !== "") lines.push(current)
	return lines
}

interface CheckCoverage {
	check: string
	needs: string
	ran: number
	skipped: number
	blocked: number
	skippedEntities: string[]
	blockedEntities: string[]
}

export function coverageByCheck(input: ReportInput): {
	never: CheckCoverage[]
	partialSkip: CheckCoverage[]
	blocked: CheckCoverage[]
} {
	const tested = input.entitiesTested.length
	const rows = new Map<string, CheckCoverage>()
	const row = (check: string, needs: string): CheckCoverage => {
		const existing = rows.get(check)
		if (existing !== undefined) return existing
		const created: CheckCoverage = {
			blocked: 0,
			blockedEntities: [],
			check,
			needs,
			ran: 0,
			skipped: 0,
			skippedEntities: [],
		}
		rows.set(check, created)
		return created
	}
	for (const entry of input.checksSkipped ?? []) {
		const current = row(entry.check, entry.needs)
		current.skipped += 1
		current.skippedEntities.push(entry.entity)
	}
	for (const entry of input.checksSuppressed ?? []) {
		const current = row(entry.check, "a check it depends on already failed")
		current.blocked += 1
		current.blockedEntities.push(entry.entity)
	}
	const outOfScope = new Map<string, number>()
	for (const entry of input.checksOutOfScope ?? []) outOfScope.set(entry.check, (outOfScope.get(entry.check) ?? 0) + 1)
	for (const current of rows.values()) {
		current.ran = Math.max(0, tested - current.skipped - current.blocked - (outOfScope.get(current.check) ?? 0))
	}
	const all = [...rows.values()].sort((a, b) => a.check.localeCompare(b.check))
	return {
		blocked: all.filter((item) => item.blocked > 0),
		never: all.filter((item) => item.ran === 0 && item.blocked === 0 && item.skipped > 0),
		partialSkip: all.filter((item) => item.ran > 0 && item.skipped > 0),
	}
}

function entityList(names: readonly string[]): string {
	if (names.length === 0) return "none"
	if (names.length <= 12) return names.join(", ")
	return `${names.length} entities`
}

function named(names: readonly string[], keep = 6): string {
	if (names.length <= keep) return names.join(", ")
	return `${names.slice(0, keep).join(", ")} +${names.length - keep} more`
}

/**
 * One line naming what `--profile` narrowed and why — silently shrinking coverage is the failure
 * mode to avoid, so a gated run says exactly what it skipped, the same way a coverage gap does.
 * `null` on the default `"full"` profile with nothing excluded: nothing to say.
 */
function profileExclusionSummary(input: ReportInput): string | null {
	const exclusions = input.profileExclusions ?? []
	if (exclusions.length === 0) return null
	const highCost = exclusions.filter((e) => e.reason.startsWith("x-cost")).length
	const destructive = exclusions.filter((e) => e.reason === "x-destructive").length
	const byName = exclusions.length - highCost - destructive
	const parts = [
		highCost > 0 ? `${highCost} high-cost` : null,
		destructive > 0 ? `${destructive} destructive` : null,
		byName > 0 ? `${byName} excluded by name` : null,
	].filter((part): part is string => part !== null)
	return (
		`skipped ${exclusions.length} operation(s) under --profile ${input.profile ?? "?"}` +
		(parts.length > 0 ? ` (${parts.join(", ")})` : "")
	)
}

const STATUS_MARK: Record<OperationStatus, string> = {
	blocked: "○",
	failed: "✗",
	held: "✓",
	inconclusive: "?",
	untested: "○",
}

function operationLabel(op: OperationCoverage): string {
	return op.origin === undefined ? op.operationId : `${op.origin}:${op.operationId}`
}

/** One line naming the scope: what was asked for, or that the run was full. */
function scopeLine(scope: ScopeReport, dash: string): string {
	if (scope.mode === "full") {
		const graded = scope.operations.filter((op) => op.status !== "untested").length
		return `full${dash}${graded} of ${scope.operations.length} operations graded`
	}
	const n = scope.operations.length
	return `targeted${dash}${n} operation${n === 1 ? "" : "s"} (${describeRequested(scope.requested)})`
}

function scopeSections(scope: ScopeReport): string[] {
	const lines = ["## Operations", ""]
	lines.push(
		scope.mode === "full"
			? "> Every operation in the document and whether any check graded it. `untested` names why not."
			: "> The targets of this run. Everything else oat called is listed under support: called, never graded.",
	)
	lines.push("")
	lines.push("| operation | entity | status | held | failed | suppressed | inconclusive | reason |")
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |")
	for (const op of scope.operations) {
		const failed = op.checks.failed.length === 0 ? "0" : `${op.checks.failed.length} (${op.checks.failed.join(", ")})`
		lines.push(
			`| ${operationLabel(op)} | ${op.entity ?? "—"} | ${op.status} | ${op.checks.held.length} | ${failed} | ` +
				`${op.checks.suppressed.length} | ${op.checks.inconclusive.length} | ${(op.reason ?? "").replace(/\|/g, "\\|")} |`,
		)
	}
	lines.push("")
	if (scope.originsSkipped.length > 0) {
		lines.push(`Origins not run — no target named them: ${scope.originsSkipped.join(", ")}.`)
		lines.push("")
	}
	if (scope.excluded.length > 0) {
		lines.push(`Excluded by the profile: ${scope.excluded.map((e) => `${e.operationId} (${e.reason})`).join(", ")}.`)
		lines.push("")
	}
	if (scope.mode === "targeted") {
		lines.push("## Support operations")
		lines.push("")
		lines.push("> Called to reach or observe a target. Not graded: a defect here is out of this run's scope.")
		lines.push("")
		if (scope.support.length === 0) {
			lines.push("None.")
		} else {
			lines.push("| operation | calls | non-2xx | first failure |")
			lines.push("| --- | --- | --- | --- |")
			for (const use of scope.support) {
				const label = use.origin === undefined ? use.operationId : `${use.origin}:${use.operationId}`
				const first =
					use.firstFailure === undefined
						? ""
						: `${use.firstFailure.status}${use.firstFailure.requestId === "" ? "" : ` (${use.firstFailure.requestId})`}`
				lines.push(`| ${label} | ${use.calls} | ${use.non2xx} | ${first} |`)
			}
		}
		lines.push("")
	}
	return lines
}

function scopeConsole(scope: ScopeReport): string[] {
	if (scope.mode === "full") return [`  scope: ${scopeLine(scope, " · ")}`]
	const lines = [`  scope: ${scopeLine(scope, " · ")} · ${scope.support.length} support op(s)`]
	const width = Math.max(16, ...scope.operations.map((op) => operationLabel(op).length)) + 2
	for (const op of scope.operations) {
		const graded = op.checks.held.length + op.checks.failed.length + op.checks.inconclusive.length
		const detail =
			op.status === "failed"
				? `${graded} checks · ${op.findings} finding(s) (${op.checks.failed.join(", ")})`
				: op.status === "held" || op.status === "inconclusive"
					? `${graded} checks`
					: (op.reason ?? "")
		lines.push(`    ${STATUS_MARK[op.status]} ${operationLabel(op).padEnd(width)}${op.status.padEnd(14)}${detail}`)
	}
	return lines
}

/** Console summary — what shows up in CI logs. */
export function renderConsole(input: ReportInput): string {
	const { findings } = input
	const lines: string[] = []
	const real = findings.filter(isRootCause)
	const coverage = coverageByCheck(input)

	lines.push("")
	lines.push(
		`  ${input.checksRun.length} checks · ${input.entitiesTested.length} entities · ` +
			`${input.client.transcript.length} requests · ${(input.durationMs / 1000).toFixed(1)}s` +
			(latency(input.client.transcript) === null ? "" : ` · p95 ${latency(input.client.transcript)?.p95}ms`) +
			` · ${formatBytes(utf8Total(input.client.transcript, "request"))} req · ${formatBytes(utf8Total(input.client.transcript, "response"))} res` +
			(coverage.never.length > 0 ? ` · ${coverage.never.length} checks did not apply` : "") +
			(coverage.partialSkip.length > 0 ? ` · ${coverage.partialSkip.length} only on some entities` : ""),
	)
	const profileLine = profileExclusionSummary(input)
	if (profileLine !== null) lines.push(`  ${profileLine}`)
	if (input.scope !== undefined) lines.push(...scopeConsole(input.scope))
	lines.push("")

	const renderSkipped = (): void => {
		if (coverage.never.length > 0) {
			lines.push("  DID NOT APPLY — no entity had what these need")
			for (const row of coverage.never) {
				lines.push(`    ${row.check.padEnd(40)} needs ${row.needs}`)
			}
			lines.push("")
		}
		if (coverage.partialSkip.length > 0) {
			lines.push("  APPLIED ONLY ON SOME ENTITIES")
			for (const row of coverage.partialSkip) {
				lines.push(
					`    ${row.check.padEnd(40)} ran on ${row.ran} · skipped on ${row.skipped} (${named(row.skippedEntities)})`,
				)
			}
			lines.push("")
		}
	}

	/*
	 * Neither of these is a pass, and both were previously invisible.
	 *
	 * A suppressed check was never run: its premise was already broken, so running it would have
	 * reported the same root cause a second time. An inconclusive one ran and could not decide.
	 * Either way the property is *untested*, and a report that shows only findings invites the
	 * reader to assume everything else was verified.
	 */
	const renderUntested = (): void => {
		const blockedAll = coverage.blocked.filter((row) => row.ran === 0)
		const blockedSome = coverage.blocked.filter((row) => row.ran > 0)
		if (blockedAll.length > 0) {
			lines.push("  BLOCKED BY AN EARLIER FAILURE — re-run once the cause is fixed")
			for (const row of blockedAll) {
				const because = (input.checksSuppressed ?? []).find((s) => s.check === row.check)?.because
				lines.push(`    ${row.check.padEnd(40)} waiting on ${because ?? "an earlier check"}`)
			}
			lines.push("")
		}
		if (blockedSome.length > 0) {
			lines.push("  BLOCKED ON SOME ENTITIES")
			for (const row of blockedSome) {
				const because = (input.checksSuppressed ?? []).find((s) => s.check === row.check)?.because
				lines.push(
					`    ${row.check.padEnd(40)} ran on ${row.ran} · blocked on ${row.blocked} (${named(row.blockedEntities)})` +
						(because === undefined ? "" : ` · waiting on ${because}`),
				)
			}
			lines.push("")
		}

		const unresolved = input.inconclusive ?? []
		if (unresolved.length > 0) {
			lines.push("  COULD NOT CONCLUDE")
			const byCheck = new Map<string, string>()
			for (const entry of unresolved) byCheck.set(entry.check, entry.reason)
			for (const [check, reason] of [...byCheck].sort()) {
				lines.push(`    ${check}`)
				lines.push(`      ${reason}`)
			}
			lines.push("")
		}
	}

	if (real.length === 0 && findings.length === 0) {
		lines.push("  no defects found")
		lines.push("")
		/* Printed even on a clean run — especially on a clean run. "Nothing found" and "nothing
		 * was looked for" read identically without it. */
		renderUntested()
		renderSkipped()
		return lines.join("\n")
	}

	for (const verdict of VERDICT_ORDER) {
		const group = findings.filter((f) => f.verdict === verdict)
		if (group.length === 0) continue
		lines.push(`  ${VERDICT_LABEL[verdict].toUpperCase()} (${group.length})`)
		for (const finding of group) {
			const entityLabel =
				finding.origin === undefined || finding.origin === "" ? finding.entity : `${finding.origin}/${finding.entity}`
			const subject =
				finding.fixture !== undefined && finding.fixture !== "" && !entityLabel.includes(" · ")
					? `${entityLabel} · ${finding.fixture}`
					: entityLabel
			lines.push(`    ${subject.padEnd(16)} ${finding.summary}`)
			lines.push(`    ${"".padEnd(16)} ${finding.check}`)
		}
		lines.push("")
	}

	renderUntested()
	renderSkipped()

	return lines.join("\n")
}

/** Machine-readable output for CI gating and diffing between runs. */
/**
 * Latency percentiles over the run, and the single slowest request.
 *
 * A run is a few hundred requests against every read path an API has, which makes it a usable
 * sample of where time actually goes — and the slowest exchange is very often a route with a
 * missing index rather than a slow network. Reported, not asserted: oat has no baseline to judge
 * "too slow" against, and inventing a threshold would produce a finding nobody can act on.
 */
function utf8Total(transcript: readonly Exchange[], side: "request" | "response"): number {
	let total = 0
	for (const exchange of transcript) {
		total += side === "request" ? exchange.requestBytes : exchange.responseBytes
	}
	return total
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} bytes`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function latency(
	transcript: readonly Exchange[],
): { p50: number; p95: number; max: number; slowest: { method: string; path: string } } | null {
	if (transcript.length === 0) return null
	const sorted = [...transcript].sort((a, b) => a.durationMs - b.durationMs)
	const at = (fraction: number): number => {
		const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
		return sorted[index]?.durationMs ?? 0
	}
	const slowest = sorted.at(-1)
	return {
		max: slowest?.durationMs ?? 0,
		p50: at(0.5),
		p95: at(0.95),
		slowest: {
			method: slowest?.method ?? "",
			path: slowest === undefined ? "" : new URL(slowest.url).pathname,
		},
	}
}

export function renderJson(input: ReportInput): string {
	const coverage = coverageByCheck(input)
	return `${JSON.stringify(
		{
			backend: input.baseUrl,
			checksRun: input.checksRun,
			checksSkipped: input.checksSkipped ?? [],
			checksSuppressed: input.checksSuppressed ?? [],
			inconclusive: input.inconclusive ?? [],
			profile: input.profile ?? "full",
			profileExclusions: input.profileExclusions ?? [],
			...(input.scope === undefined ? {} : { scope: input.scope }),
			checksOutOfScope: input.checksOutOfScope ?? [],
			durationMs: input.durationMs,
			entitiesTested: input.entitiesTested,
			findings: input.findings.map((finding) => ({
				check: finding.check,
				detail: finding.detail,
				entity: finding.entity,
				...(finding.fixture === undefined ? {} : { fixture: finding.fixture }),
				...(finding.operations === undefined ? {} : { operations: finding.operations }),
				evidence: finding.evidence.map((exchange) => ({
					at: new Date(exchange.at).toISOString(),
					durationMs: exchange.durationMs,
					method: exchange.method,
					requestBody: redactJson(describeRequestBody(exchange.requestBody)),
					requestBytes: exchange.requestBytes,
					requestId: exchange.requestId,
					responseBody: redactJson(exchange.responseBody),
					responseBytes: exchange.responseBytes,
					status: exchange.status,
					url: redactUrl(exchange.url),
				})),
				summary: finding.summary,
				verdict: finding.verdict,
			})),
			generatedAt: input.startedAt.toISOString(),
			requests: input.client.transcript.length,
			...(input.network === undefined ? {} : { network: input.network }),
			requestBytes: utf8Total(input.client.transcript, "request"),
			responseBytes: utf8Total(input.client.transcript, "response"),
			latency: latency(input.client.transcript),
			costByCheck: costByCheck(input),
			observed: input.checkNotes ?? [],
			summary: Object.fromEntries(
				VERDICT_ORDER.map((verdict) => [verdict, input.findings.filter((f) => f.verdict === verdict).length]).filter(
					([, count]) => (count as number) > 0,
				),
			),
			coverage: {
				neverApplied: coverage.never.map((row) => row.check),
				partial: coverage.partialSkip.map((row) => ({
					check: row.check,
					ran: row.ran,
					skipped: row.skipped,
				})),
			},
		},
		null,
		2,
	)}\n`
}

/** Checks named in the summary's cost line. */
const COST_ROWS = 5

/**
 * What each check cost: the requests it sent, counted from the transcript, and its wall time
 * summed over entities. Costliest first, by requests.
 */
function costByCheck(input: ReportInput): Array<{ check: string; requests: number; ms: number }> {
	const rows = new Map<string, { check: string; requests: number; ms: number }>()
	const row = (check: string): { check: string; requests: number; ms: number } => {
		const existing = rows.get(check)
		if (existing !== undefined) return existing
		const created = { check, ms: 0, requests: 0 }
		rows.set(check, created)
		return created
	}
	for (const exchange of input.client.transcript) if (exchange.check !== undefined) row(exchange.check).requests += 1
	for (const timing of input.checkTimings ?? []) row(timing.check).ms += timing.ms
	return [...rows.values()].sort((a, b) => b.requests - a.requests || b.ms - a.ms || a.check.localeCompare(b.check))
}
