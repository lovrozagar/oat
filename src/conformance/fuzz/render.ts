/** The fuzz and precision runs as the conformance report prints them. */

import type { FuzzCase, PrecisionCase } from "./diagnose.ts"

export function renderFuzz(results: FuzzCase[]): { text: string; failures: number } {
	const lines: string[] = []
	const failed = results.filter((result) => !result.ok)
	lines.push("")
	lines.push("  combination fuzzing — random defect sets, one run each")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")

	for (const result of failed) {
		lines.push(`  ✗ seed ${result.seed}  [${result.injected.join(" + ")}]`)
		if (result.error !== undefined) lines.push(`      run failed: ${result.error}`)
		for (const miss of result.missed) {
			lines.push(`      missed   ${miss.defect} — expected ${miss.primary}, nothing fired`)
		}
		for (const extra of result.spurious) {
			lines.push(`      spurious ${extra.check}${extra.entity === "" ? "" : ` (${extra.entity})`}`)
			lines.push(`               ${extra.summary}`)
			/* Truncated, not omitted: the evidence is what distinguishes a real regression from a
			 * timing artefact, and a rare case may never reproduce on demand. */
			lines.push(`               ${extra.detail.replace(/\s+/g, " ").slice(0, 200)}`)
		}
	}

	const cascaded = results.reduce((sum, result) => sum + result.cascaded.length, 0)
	const unresolved = results.reduce((sum, result) => sum + result.unresolved.length, 0)
	lines.push("")
	lines.push(
		`  ${results.length - failed.length}/${results.length} combinations diagnosed correctly` +
			` · ${cascaded} suppressed as cascades` +
			` · ${unresolved} reported as inconclusive`,
	)
	lines.push("")
	return { failures: failed.length, text: lines.join("\n") }
}

export function renderPrecision(results: PrecisionCase[]): { text: string; failures: number } {
	const lines: string[] = []
	const bad = results.filter((r) => r.findings.length > 0 || r.error !== undefined)
	lines.push("")
	lines.push("  precision stress — correct backend, varied cohort data")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")
	for (const result of bad) {
		lines.push(`  ✗ seed ${result.seed}`)
		if (result.error !== undefined) lines.push(`      run failed: ${result.error}`)
		for (const finding of result.findings) {
			lines.push(`      false positive ${finding.check} (${finding.entity}) — ${finding.summary}`)
		}
	}
	const unresolved = results.reduce((sum, r) => sum + r.inconclusive, 0)
	lines.push("")
	lines.push(
		`  ${results.length - bad.length}/${results.length} cohorts produced no false positives` +
			` · ${unresolved} check(s) reported as inconclusive`,
	)
	lines.push("")
	return { failures: bad.length, text: lines.join("\n") }
}
