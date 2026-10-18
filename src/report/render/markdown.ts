/**
 * Report rendering.
 *
 * The previous generation of this tool produced 88 failures that a human then spent days sorting
 * into five root causes by hand, and the artifact that team actually used was a set of
 * hand-written curl scripts. So: group by root cause, lead with severity, and generate the
 * reproducers.
 */

import { runVerdict } from "../../runtime/exit.ts"
import { isFailingRootCause } from "../../runtime/finding.ts"
import { coverageByCheck } from "./coverage.ts"
import type { ReportInput } from "./input.ts"
import { headLines } from "./markdown-head.ts"
import { findingSections } from "./markdown-findings.ts"
import {
	coverageSections,
	fencedSection,
	fixedSection,
	isKnown,
	knownSection,
	leftoverSections,
	observedSection,
	outcomeSection,
} from "./markdown-sections.ts"
import { scopeSections } from "./scope.ts"

/** The markdown report: the run in summary, then every finding grouped by severity. */
export function renderMarkdown(input: ReportInput): string {
	const redactor = input.client.redactor
	/* Known findings have a section of their own; everything else reads as it always has. */
	const findings = input.findings.filter((finding) => finding.known === undefined)
	const known = input.findings.filter(isKnown)
	const coverage = coverageByCheck(input)
	const verdict = runVerdict(input)
	const lines = [
		...headLines(input, verdict, coverage),
		...leftoverSections(input, redactor),
		...fencedSection(input, redactor),
		...observedSection(input),
		...outcomeSection(input, findings, { defects: findings.filter(isFailingRootCause).length, verdict }),
		...(input.scope === undefined ? [] : scopeSections(input.scope)),
		...knownSection(known),
		...fixedSection(input),
		...findingSections(findings, redactor),
		...coverageSections(coverage),
	]
	return `${lines.join("\n")}\n`
}
