/**
 * Conformance cases known to fail today, and why.
 *
 * Each entry is a correct backend oat still misjudges. The list may only shrink: a listed case
 * that starts passing fails the suite until its entry is removed, so a fix is recorded the moment
 * it lands and a regression cannot hide behind an entry that is no longer needed.
 *
 * Keys are case names as the suite prints them (`shape:<name>`, `recall:<shape>:<defect>`).
 */
export const EXPECTED_FAILURES: Readonly<Record<string, string>> = {}

/**
 * Inconclusive verdicts a clean baseline may return, per `backend:dialect`, as `check@entity`.
 *
 * A check that cannot decide against a correct backend has not shown that it passes, so any
 * verdict not listed here fails the baseline. Like the list above, this may only shrink.
 */
export const EXPECTED_INCONCLUSIVE: Readonly<Record<string, readonly string[]>> = {}
