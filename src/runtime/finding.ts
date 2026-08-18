/**
 * Findings carry their verdict, not a severity guess made at report time. The verdict is derived
 * from what the evidence shows, which is what lets the report collapse cascades and lets the
 * conformance suite assert "exactly this defect was detected".
 */

import type { Exchange } from "./client.ts"

export type Verdict = "BACKEND_BUG" | "SPEC_BUG" | "SECURITY" | "AMBIGUITY" | "COVERAGE_GAP" | "BLOCKED"

export interface Finding {
	/** Stable identifier for the check that produced this — the conformance suite asserts on it. */
	check: string
	verdict: Verdict
	entity: string
	summary: string
	detail: string
	evidence: Exchange[]
	/** Set when the finding came from a non-primary `origins[]` host. */
	origin?: string
	/** Fixture filename when `uploads.each` drove the invocation. */
	fixture?: string
}

/**
 * A check that ran, could not reach a verdict, and stopped.
 *
 * Distinct from a skip (the entity never had what the check needs) and from a pass (the property
 * was tested and held). Before this existed a check that bailed halfway — no matching field, an
 * empty listing, a probe that errored — simply returned, and the report was identical to one
 * where the property was verified. On a backend with several faults that is most of the suite
 * going quiet at once, which is the precise moment a reader most needs to know it happened.
 */
export interface Inconclusive {
	check: string
	entity: string
	/** Why no verdict was reachable, in the reader's terms. */
	reason: string
}

function withFixture(finding: Finding, fixture?: string): Finding {
	if (fixture === undefined || fixture === "") return finding
	return { ...finding, fixture }
}

export class FindingCollector {
	readonly findings: Finding[] = []
	readonly inconclusive: Inconclusive[] = []

	/**
	 * Records that a check ran without reaching a verdict. Returns `undefined` so a check can
	 * `return ctx.findings.unresolved(...)` at the point it gives up, which keeps the reason
	 * beside the condition that caused it rather than in a comment.
	 */
	unresolved(check: string, entity: string, reason: string): undefined {
		this.inconclusive.push({ check, entity, reason })
		return undefined
	}

	report(finding: Finding): void {
		this.findings.push(finding)
	}

	backend(
		check: string,
		entity: string,
		summary: string,
		detail: string,
		evidence: Exchange[],
		fixture?: string,
	): void {
		this.report(withFixture({ check, detail, entity, evidence, summary, verdict: "BACKEND_BUG" }, fixture))
	}

	security(
		check: string,
		entity: string,
		summary: string,
		detail: string,
		evidence: Exchange[],
		fixture?: string,
	): void {
		this.report(withFixture({ check, detail, entity, evidence, summary, verdict: "SECURITY" }, fixture))
	}

	spec(check: string, entity: string, summary: string, detail: string, evidence: Exchange[], fixture?: string): void {
		this.report(withFixture({ check, detail, entity, evidence, summary, verdict: "SPEC_BUG" }, fixture))
	}

	gap(check: string, entity: string, summary: string, detail: string, fixture?: string): void {
		this.report(withFixture({ check, detail, entity, evidence: [], summary, verdict: "COVERAGE_GAP" }, fixture))
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
