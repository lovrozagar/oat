/**
 * Findings carry their verdict, not a severity guess made at report time. The verdict is derived
 * from what the evidence shows, which is what lets the report collapse cascades and lets the
 * conformance suite assert "exactly this defect was detected".
 */

import type { Exchange } from "./client.ts"

export type Verdict =
	| "BACKEND_BUG"
	| "SPEC_BUG"
	| "SECURITY"
	| "AMBIGUITY"
	| "COVERAGE_GAP"
	| "BLOCKED"

export interface Finding {
	/** Stable identifier for the check that produced this — the conformance suite asserts on it. */
	check: string
	verdict: Verdict
	entity: string
	summary: string
	detail: string
	evidence: Exchange[]
}

export class FindingCollector {
	readonly findings: Finding[] = []

	report(finding: Finding): void {
		this.findings.push(finding)
	}

	backend(
		check: string,
		entity: string,
		summary: string,
		detail: string,
		evidence: Exchange[],
	): void {
		this.report({ check, detail, entity, evidence, summary, verdict: "BACKEND_BUG" })
	}

	security(
		check: string,
		entity: string,
		summary: string,
		detail: string,
		evidence: Exchange[],
	): void {
		this.report({ check, detail, entity, evidence, summary, verdict: "SECURITY" })
	}

	spec(check: string, entity: string, summary: string, detail: string, evidence: Exchange[]): void {
		this.report({ check, detail, entity, evidence, summary, verdict: "SPEC_BUG" })
	}

	gap(check: string, entity: string, summary: string, detail: string): void {
		this.report({ check, detail, entity, evidence: [], summary, verdict: "COVERAGE_GAP" })
	}

	blocked(check: string, entity: string, summary: string, cause: string): void {
		this.report({
			check,
			detail: `blocked by ${cause}`,
			entity,
			evidence: [],
			summary,
			verdict: "BLOCKED",
		})
	}

	checks(): string[] {
		return [...new Set(this.findings.map((f) => f.check))].sort()
	}

	byVerdict(verdict: Verdict): Finding[] {
		return this.findings.filter((f) => f.verdict === verdict)
	}
}
