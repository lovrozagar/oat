/**
 * Report rendering.
 *
 * The previous generation of this tool produced 88 failures that a human then spent days sorting
 * into five root causes by hand, and the artifact that team actually used was a set of
 * hand-written curl scripts. So: group by root cause, lead with severity, and generate the
 * reproducers.
 */

import { toCurl } from "../runtime/client.ts"
import type { Client, Exchange } from "../runtime/client.ts"
import type { Finding, Verdict } from "../runtime/finding.ts"
import type { SpecModel } from "../spec/graph.ts"

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
	/** Checks that ran but could not reach a verdict, with the reason they stopped. */
	inconclusive?: Array<{ check: string; entity: string; reason: string }>
	startedAt: Date
	durationMs: number
}

const VERDICT_ORDER: Verdict[] = [
	"SECURITY",
	"BACKEND_BUG",
	"SPEC_BUG",
	"AMBIGUITY",
	"BLOCKED",
	"COVERAGE_GAP",
]

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
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
}

function truncate(value: unknown, max = 600): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
	if (text === undefined) return "—"
	return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text
}

function exchangeBlock(exchange: Exchange): string[] {
	const lines: string[] = []
	lines.push("")
	lines.push(`\`${exchange.method} ${new URL(exchange.url).pathname}${new URL(exchange.url).search}\` → **${exchange.status}** (${exchange.durationMs}ms)`)
	if (exchange.requestBody !== undefined) {
		lines.push("")
		lines.push("<details><summary>request body</summary>")
		lines.push("")
		lines.push("```json")
		lines.push(truncate(exchange.requestBody))
		lines.push("```")
		lines.push("")
		lines.push("</details>")
	}
	if (exchange.responseBody !== null && exchange.responseBody !== undefined) {
		lines.push("")
		lines.push("<details><summary>response body</summary>")
		lines.push("")
		lines.push("```json")
		lines.push(truncate(exchange.responseBody))
		lines.push("```")
		lines.push("")
		lines.push("</details>")
	}
	return lines
}

export function renderMarkdown(input: ReportInput): string {
	const { findings } = input
	const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP" && f.verdict !== "BLOCKED")
	const lines: string[] = []

	lines.push("# oat report")
	lines.push("")
	lines.push(`- **Backend**: ${input.baseUrl}`)
	lines.push(`- **Generated**: ${input.startedAt.toISOString()} (${(input.durationMs / 1000).toFixed(1)}s)`)
	lines.push(`- **Entities tested**: ${input.entitiesTested.join(", ") || "none"}`)
	lines.push(`- **Checks run**: ${input.checksRun.length}`)
	const skippedCount = new Set((input.checksSkipped ?? []).map((s) => s.check)).size
	if (skippedCount > 0) lines.push(`- **Checks that did not apply**: ${skippedCount}`)
	const suppressedCount = new Set((input.checksSuppressed ?? []).map((s) => s.check)).size
	if (suppressedCount > 0) {
		lines.push(`- **Checks blocked by an earlier failure**: ${suppressedCount}`)
	}
	const unresolvedCount = new Set((input.inconclusive ?? []).map((s) => s.check)).size
	if (unresolvedCount > 0) lines.push(`- **Checks that could not conclude**: ${unresolvedCount}`)
	lines.push(`- **Requests**: ${input.client.transcript.length}`)
	const timing = latency(input.client.transcript)
	if (timing !== null) {
		lines.push(
			`- **Latency**: p50 ${timing.p50}ms · p95 ${timing.p95}ms · max ${timing.max}ms `
				+ `(${timing.slowest.method} ${timing.slowest.path})`,
		)
	}
	lines.push("")

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

	for (const verdict of VERDICT_ORDER) {
		const group = findings.filter((f) => f.verdict === verdict)
		if (group.length === 0) continue

		lines.push(`## ${VERDICT_LABEL[verdict]}`)
		lines.push("")
		lines.push(`> ${VERDICT_NOTE[verdict]}`)
		lines.push("")

		for (const finding of group) {
			lines.push(`### ${finding.entity} — ${finding.summary}`)
			lines.push("")
			lines.push(`\`${finding.check}\``)
			lines.push("")
			lines.push(finding.detail)
			for (const exchange of finding.evidence.slice(0, 3)) {
				lines.push(...exchangeBlock(exchange))
			}
			if (finding.evidence.length > 0) {
				lines.push("")
				lines.push(`Reproduce: \`repro/${slug(`${finding.entity}-${finding.check}`)}.sh\``)
			}
			lines.push("")
		}
	}

	return `${lines.join("\n")}\n`
}

export interface ReproScript {
	filename: string
	content: string
}

/** One runnable script per finding — the artifact a backend developer actually opens. */
export function renderRepros(findings: Finding[], baseUrl: string): ReproScript[] {
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
			lines.push(`BASE="\${BASE:-${baseUrl}}"`)
			lines.push('TOKEN="${TOKEN:?set TOKEN to a valid credential}"')
			lines.push("")

			finding.evidence.forEach((exchange, index) => {
				lines.push(`# step ${index + 1} — observed ${exchange.status}`)
				lines.push(toCurl(exchange, { origin: new URL(exchange.url).origin }))
				lines.push("")
			})

			return {
				content: `${lines.join("\n")}\n`,
				filename: `${slug(`${finding.entity}-${finding.check}`)}.sh`,
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

/** Console summary — what shows up in CI logs. */
export function renderConsole(input: ReportInput): string {
	const { findings } = input
	const lines: string[] = []
	const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP" && f.verdict !== "BLOCKED")

	lines.push("")
	const skipped = input.checksSkipped ?? []
	const distinctSkipped = new Set(skipped.map((s) => s.check))
	lines.push(
		`  ${input.checksRun.length} checks · ${input.entitiesTested.length} entities · ` +
			`${input.client.transcript.length} requests · ${(input.durationMs / 1000).toFixed(1)}s` +
			(latency(input.client.transcript) === null
				? ""
				: ` · p95 ${latency(input.client.transcript)?.p95}ms`) +
			(distinctSkipped.size > 0 ? ` · ${distinctSkipped.size} checks did not apply` : ""),
	)
	lines.push("")

	const renderSkipped = (): void => {
		if (distinctSkipped.size === 0) return
		lines.push("  DID NOT APPLY")
		const byCheck = new Map<string, string>()
		for (const entry of skipped) byCheck.set(entry.check, entry.needs)
		for (const [check, needs] of [...byCheck].sort()) {
			lines.push(`    ${check.padEnd(40)} needs ${needs}`)
		}
		lines.push("")
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
		const suppressed = input.checksSuppressed ?? []
		if (suppressed.length > 0) {
			lines.push("  BLOCKED BY AN EARLIER FAILURE — re-run once the cause is fixed")
			const byCheck = new Map<string, string>()
			for (const entry of suppressed) byCheck.set(entry.check, entry.because)
			for (const [check, because] of [...byCheck].sort()) {
				lines.push(`    ${check.padEnd(40)} waiting on ${because}`)
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
			lines.push(`    ${finding.entity.padEnd(16)} ${finding.summary}`)
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
	return `${JSON.stringify(
		{
			backend: input.baseUrl,
			checksRun: input.checksRun,
			checksSkipped: input.checksSkipped ?? [],
			checksSuppressed: input.checksSuppressed ?? [],
			inconclusive: input.inconclusive ?? [],
			durationMs: input.durationMs,
			entitiesTested: input.entitiesTested,
			findings: input.findings.map((finding) => ({
				check: finding.check,
				detail: finding.detail,
				entity: finding.entity,
				evidence: finding.evidence.map((exchange) => ({
					method: exchange.method,
					requestBody: exchange.requestBody,
					responseBody: exchange.responseBody,
					status: exchange.status,
					url: exchange.url,
				})),
				summary: finding.summary,
				verdict: finding.verdict,
			})),
			generatedAt: input.startedAt.toISOString(),
			requests: input.client.transcript.length,
			latency: latency(input.client.transcript),
			summary: Object.fromEntries(
				VERDICT_ORDER.map((verdict) => [
					verdict,
					input.findings.filter((f) => f.verdict === verdict).length,
				]).filter(([, count]) => (count as number) > 0),
			),
		},
		null,
		2,
	)}\n`
}
