import { runVerdict } from "../../runtime/exit.ts"
import type { Finding } from "../../runtime/finding.ts"
import { type Coverage, coverageByCheck, profileExclusionSummary } from "./coverage.ts"
import type { ReportInput } from "./input.ts"
import { scopeConsole } from "./scope.ts"
import { formatBytes, named } from "./text.ts"
import { latency, utf8Total } from "./traffic.ts"
import { byVerdict, findingSubject, VERDICT_LABEL } from "./verdicts.ts"

/** The first line: how much ran, how long it took, and what did not apply. */
function headline(input: ReportInput, coverage: Coverage): string {
	const transcript = input.client.transcript
	const timing = latency(transcript)
	return (
		`  ${input.checksRun.length} checks · ${input.entitiesTested.length} entities · ` +
		`${transcript.length} requests · ${(input.durationMs / 1000).toFixed(1)}s` +
		(timing === null ? "" : ` · p95 ${timing.p95}ms`) +
		` · ${formatBytes(utf8Total(transcript, "request"))} req · ${formatBytes(utf8Total(transcript, "response"))} res` +
		(coverage.never.length > 0 ? ` · ${coverage.never.length} checks did not apply` : "") +
		(coverage.partialSkip.length > 0 ? ` · ${coverage.partialSkip.length} only on some entities` : "")
	)
}

/** Checks that did not apply anywhere, and those that applied only on some entities. */
function skippedLines(coverage: Coverage): string[] {
	const lines: string[] = []
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
				`    ${row.check.padEnd(40)} ran ${row.ran > 0 ? `on ${row.ran}` : "per operation"} · skipped on ${row.skipped} (${named(row.skippedEntities)})`,
			)
		}
		lines.push("")
	}
	return lines
}

/** What a blocked check waited on. Every blocked row came from a suppression, so one is there. */
function blockedBy(input: ReportInput, check: string): string {
	const suppressed = input.checksSuppressed as NonNullable<ReportInput["checksSuppressed"]>
	return (suppressed.find((s) => s.check === check) as { because: string }).because
}

/** Checks never run because an earlier check had already failed. */
function blockedLines(input: ReportInput, coverage: Coverage): string[] {
	const lines: string[] = []
	const blockedAll = coverage.blocked.filter((row) => row.ran === 0)
	const blockedSome = coverage.blocked.filter((row) => row.ran > 0)
	if (blockedAll.length > 0) {
		lines.push("  BLOCKED BY AN EARLIER FAILURE — re-run once the cause is fixed")
		for (const row of blockedAll) lines.push(`    ${row.check.padEnd(40)} waiting on ${blockedBy(input, row.check)}`)
		lines.push("")
	}
	if (blockedSome.length > 0) {
		lines.push("  BLOCKED ON SOME ENTITIES")
		for (const row of blockedSome) {
			lines.push(
				`    ${row.check.padEnd(40)} ran on ${row.ran} · blocked on ${row.blocked} (${named(row.blockedEntities)})` +
					` · waiting on ${blockedBy(input, row.check)}`,
			)
		}
		lines.push("")
	}
	return lines
}

/** Checks that ran and could not decide, each with the reason it stopped. */
function inconclusiveLines(input: ReportInput): string[] {
	const unresolved = input.inconclusive ?? []
	if (unresolved.length === 0) return []
	const lines = ["  COULD NOT CONCLUDE"]
	const byCheck = new Map<string, string>()
	for (const entry of unresolved) byCheck.set(entry.check, entry.reason)
	for (const [check, reason] of [...byCheck].sort()) {
		lines.push(`    ${check}`)
		lines.push(`      ${reason}`)
	}
	lines.push("")
	return lines
}

/*
 * Neither of these is a pass, and both were previously invisible.
 *
 * A suppressed check was never run: its premise was already broken, so running it would have
 * reported the same root cause a second time. An inconclusive one ran and could not decide.
 * Either way the property is *untested*, and a report that shows only findings invites the
 * reader to assume everything else was verified.
 */
function untestedLines(input: ReportInput, coverage: Coverage): string[] {
	return [...blockedLines(input, coverage), ...inconclusiveLines(input)]
}

/** A section per severity, each finding's subject and summary over its check id. */
function findingLines(findings: readonly Finding[]): string[] {
	const lines: string[] = []
	for (const [findingVerdict, group] of byVerdict(findings)) {
		lines.push(`  ${VERDICT_LABEL[findingVerdict].toUpperCase()} (${group.length})`)
		for (const finding of group) {
			lines.push(`    ${findingSubject(finding).padEnd(16)} ${finding.summary}`)
			lines.push(`    ${"".padEnd(16)} ${finding.check}`)
		}
		lines.push("")
	}
	return lines
}

/** Console summary — what shows up in CI logs. */
/*
 * What seeding noted about an entity's records: ones no read showed stored stand checks down,
 * and a run that says nothing of it reads as a clean pass.
 */
function seedNoteLines(input: ReportInput): string[] {
	return (input.checkNotes ?? [])
		.filter((note) => note.check === "world.seed")
		.map((note) => `  note: ${note.entity} — ${note.note}`)
}

export function renderConsole(input: ReportInput): string {
	const { findings } = input
	const coverage = coverageByCheck(input)
	const lines = ["", headline(input, coverage)]
	const profileLine = profileExclusionSummary(input)
	if (profileLine !== null) lines.push(`  ${profileLine}`)
	if (input.scope !== undefined) lines.push(...scopeConsole(input.scope))
	const verdict = runVerdict(input)
	lines.push(`  result: ${verdict.outcome} — ${verdict.reason}`)
	const knownCount = findings.filter((finding) => finding.known !== undefined).length
	const fixedCount = input.baseline?.fixed.length ?? 0
	if (knownCount > 0 || fixedCount > 0) lines.push(`  baseline: ${knownCount} known · ${fixedCount} fixed`)
	lines.push(...seedNoteLines(input))
	lines.push("")
	/* With no findings at all there is no root cause either. */
	if (findings.length === 0) {
		lines.push(verdict.outcome === "failed" ? `  run failed — ${verdict.reason}` : "  no defects found")
		lines.push("")
		/* Printed even on a clean run — especially on a clean run. "Nothing found" and "nothing
		 * was looked for" read identically without it. */
	} else {
		lines.push(...findingLines(findings))
	}
	lines.push(...untestedLines(input, coverage), ...skippedLines(coverage))
	return lines.join("\n")
}
