import type { runVerdict } from "../../runtime/exit.ts"
import { type Coverage, profileExclusionSummary } from "./coverage.ts"
import type { ReportInput } from "./input.ts"
import { scopeLine } from "./scope.ts"
import { entityList, formatBytes } from "./text.ts"
import { COST_ROWS, costByCheck, latency, utf8Total } from "./traffic.ts"

type RunVerdict = ReturnType<typeof runVerdict>

/** What was tested, when, and what came of it. */
function runLines(input: ReportInput, verdict: RunVerdict): string[] {
	const lines = [`- **Backend**: ${input.baseUrl}`]
	if (input.targetVersion !== undefined) {
		lines.push(
			"value" in input.targetVersion
				? `- **Target version**: ${input.targetVersion.value}`
				: `- **Target version**: unknown — ${input.targetVersion.error}`,
		)
	}
	lines.push(`- **Result**: ${verdict.outcome} — ${verdict.reason}`)
	if (input.interrupted === true) lines.push("- **Interrupted**: stopped by a signal; teardown ran")
	lines.push(`- **Generated**: ${input.startedAt.toISOString()} (${(input.durationMs / 1000).toFixed(1)}s)`)
	if (input.scope !== undefined) lines.push(`- **Scope**: ${scopeLine(input.scope, " — ")}`)
	lines.push(`- **Entities tested**: ${entityList(input.entitiesTested)}`)
	lines.push(`- **Checks run**: ${input.checksRun.length}`)
	return lines
}

/** How many checks fell short of running everywhere, and what the profile left out. */
function coverageLines(input: ReportInput, coverage: Coverage): string[] {
	const lines: string[] = []
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
	return lines
}

/** What the run sent, how the network held up, and where the time went. */
function trafficLines(input: ReportInput): string[] {
	const transcript = input.client.transcript
	const lines = [
		`- **Requests**: ${transcript.length}` +
			` (${formatBytes(utf8Total(transcript, "request"))} req · ${formatBytes(utf8Total(transcript, "response"))} res)`,
	]
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
	const timing = latency(transcript)
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
	return lines
}

/** The report's title and its bullet summary of the run, ending in a blank line. */
export function headLines(input: ReportInput, verdict: RunVerdict, coverage: Coverage): string[] {
	return [
		"# oat report",
		"",
		...runLines(input, verdict),
		...coverageLines(input, coverage),
		...trafficLines(input),
		"",
	]
}
