import type { Finding, Verdict } from "../../runtime/finding.ts"

/** Most severe first: the order every report groups findings in. */
export const VERDICT_ORDER: Verdict[] = ["SECURITY", "BACKEND_BUG", "SPEC_BUG", "AMBIGUITY", "BLOCKED", "COVERAGE_GAP"]

export const VERDICT_LABEL: Record<Verdict, string> = {
	AMBIGUITY: "Ambiguous contract",
	BACKEND_BUG: "Backend defects",
	BLOCKED: "Blocked",
	COVERAGE_GAP: "Coverage gaps",
	SECURITY: "Security",
	SPEC_BUG: "Specification drift",
}

export const VERDICT_NOTE: Record<Verdict, string> = {
	AMBIGUITY: "The document permits both the observed and the expected behaviour. Tighten it.",
	BACKEND_BUG: "Independent projections of the same fact disagree, or a property does not hold.",
	BLOCKED: "Not evaluated because something it depends on failed. Fix the cause first.",
	COVERAGE_GAP: "oat could not test this. Each entry names what would make it testable.",
	SECURITY: "Reachable across a tenant boundary. Treat as exploitable until proven otherwise.",
	SPEC_BUG: "The backend is defensible; the document disagrees. Generated clients will break.",
}

/** Findings grouped by verdict, most severe first, with empty groups left out. */
export function byVerdict(findings: readonly Finding[]): Array<[Verdict, Finding[]]> {
	return VERDICT_ORDER.map((verdict): [Verdict, Finding[]] => [
		verdict,
		findings.filter((f) => f.verdict === verdict),
	]).filter(([, group]) => group.length > 0)
}

/** What a finding is about: its entity, under its origin, and the fixture that showed it. */
export function findingSubject(finding: Finding): string {
	const entityLabel =
		finding.origin === undefined || finding.origin === "" ? finding.entity : `${finding.origin}/${finding.entity}`
	return finding.fixture !== undefined && finding.fixture !== "" && !entityLabel.includes(" · ")
		? `${entityLabel} · ${finding.fixture}`
		: entityLabel
}
