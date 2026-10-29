/**
 * How a run says a check could not complete because the credential it needed is BLOCKED: an
 * `auth.blocked` finding whose summary names the check. One place writes the summary and one
 * reads it back, so a reader of the report (the combination fuzz among them) can tell that check
 * said why it stopped from a check that went quiet.
 */

const SUFFIX = " needed a credential that is BLOCKED"

/** The summary of the `auth.blocked` finding a check stopped on. */
export function blockedCheckSummary(check: string): string {
	return `${check}${SUFFIX}`
}

/** The check an `auth.blocked` finding stopped, or undefined for any other finding. */
export function blockedCheckOf(finding: { check: string; summary: string }): string | undefined {
	if (finding.check !== "auth.blocked" || !finding.summary.endsWith(SUFFIX)) return undefined
	return finding.summary.slice(0, -SUFFIX.length)
}
