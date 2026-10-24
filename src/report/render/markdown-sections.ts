import type { runVerdict } from "../../runtime/exit.ts"
import type { Finding } from "../../runtime/finding.ts"
import type { Redactor } from "../../security/redact.ts"
import type { Coverage } from "./coverage.ts"
import type { ReportInput } from "./input.ts"
import { named } from "./text.ts"
import { byVerdict, VERDICT_LABEL } from "./verdicts.ts"

/** A finding the baseline named. */
type KnownFinding = Finding & { known: NonNullable<Finding["known"]> }

/** Records oat made and cannot remove: first, since someone has to clean them up by hand. */
export function leftoverSections(input: ReportInput, redactor: Redactor): string[] {
	const unidentified = input.teardown?.unidentified ?? []
	const unremoved = input.teardown?.failed ?? []
	const lines: string[] = []
	if (unidentified.length > 0 || unremoved.length > 0) lines.push("## Leftovers", "")
	if (unidentified.length > 0) {
		lines.push("Each create answered 2xx, but no id could be read from its answer or confirmed by a read, so")
		lines.push("teardown could not remove what it made. Declare `x-entity.createdIdFrom` where the id is.")
		lines.push("")
		for (const create of unidentified) {
			lines.push(
				`- \`${create.method} ${redactor.url(create.url)}\` · ${create.operationId} · ${create.status} · exchange #${create.seq}`,
			)
		}
		lines.push("")
	}
	if (unremoved.length > 0) {
		lines.push("Records teardown could not show gone, each with the principal that created it:")
		lines.push("")
		for (const record of unremoved) {
			lines.push(`- ${record.entity} \`${record.id}\` · as ${record.principal} · ${record.reason}`)
		}
		lines.push("")
	}
	return lines
}

/** Requests the fence refused: never sent, so never judged — unknown, not passed. */
export function fencedSection(input: ReportInput, redactor: Redactor): string[] {
	const fenced = input.fenced?.requests ?? []
	if (fenced.length === 0) return []
	const lines = ["## Fenced requests", ""]
	for (const request of fenced) {
		lines.push(
			`- \`${request.method} ${redactor.url(request.url)}\` · ${request.operationId ?? "—"} · ${request.phase} · ${request.reason}`,
		)
	}
	lines.push("")
	return lines
}

/**
 * Policies the document leaves open, as the backend showed them. One line per policy: the same
 * observation on every entity is said once.
 */
export function observedSection(input: ReportInput): string[] {
	const observed = new Map<string, string[]>()
	for (const note of input.checkNotes ?? []) {
		observed.set(note.note, [...(observed.get(note.note) ?? []), note.entity])
	}
	if (observed.size === 0) return []
	const lines = ["## Observed behavior", ""]
	for (const [note, entities] of observed) lines.push(`- ${note} (${entities.join(", ")})`)
	lines.push("")
	return lines
}

/** How the run ended: its verdict, and how many defects it found. */
export interface RunOutcome {
	verdict: ReturnType<typeof runVerdict>
	defects: number
}

/** No defects, said plainly, or the count of findings per severity. */
export function outcomeSection(
	input: ReportInput,
	findings: readonly Finding[],
	{ defects, verdict }: RunOutcome,
): string[] {
	if (defects === 0) {
		return [
			verdict.outcome === "failed"
				? `No defects found, but the run failed: ${verdict.reason}.`
				: `No defects found across ${input.checksRun.length} checks.`,
			"",
		]
	}
	const lines = ["## Summary", "", "| severity | count |", "| --- | --- |"]
	for (const [findingVerdict, group] of byVerdict(findings)) {
		lines.push(`| ${VERDICT_LABEL[findingVerdict]} | ${group.length} |`)
	}
	lines.push("")
	return lines
}

/** True for a finding the baseline named. */
export function isKnown(finding: Finding): finding is KnownFinding {
	return finding.known !== undefined
}

/** Findings the baseline named: reported, and not counted against the run. */
export function knownSection(known: readonly KnownFinding[]): string[] {
	if (known.length === 0) return []
	const lines = ["## Known", "", "Named by the baseline: reported, and not counted against the run.", ""]
	for (const finding of known) {
		lines.push(`- **${finding.check}** on ${finding.entity} — ${finding.summary} _(known: ${finding.known.reason})_`)
	}
	lines.push("")
	return lines
}

/** Baseline entries no finding matched in this run. */
export function fixedSection(input: ReportInput): string[] {
	const fixed = input.baseline?.fixed ?? []
	if (fixed.length === 0) return []
	const lines = ["## Fixed", "", "Baseline entries no finding matched in this run:", ""]
	for (const entry of fixed) {
		const where = [entry.entity, entry.operationId].filter((part) => part !== undefined).join(" · ")
		lines.push(`- **${entry.check}**${where === "" ? "" : ` (${where})`} — ${entry.reason}`)
	}
	lines.push("")
	return lines
}

/** Checks that did not apply anywhere, and those that applied only on some entities. */
export function coverageSections(coverage: Coverage): string[] {
	const lines: string[] = []
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
			const ran = row.ran > 0 ? `on ${row.ran}` : "per operation"
			lines.push(`- \`${row.check}\` — ran ${ran}, skipped on ${row.skipped} (${named(row.skippedEntities)})`)
		}
		lines.push("")
	}
	return lines
}
