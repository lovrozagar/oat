import type { Finding } from "../../runtime/finding.ts"

export function primaryOf(expected: string | string[]): string {
	return Array.isArray(expected) ? (expected[0] ?? "") : expected
}

export function acceptableOf(expected: string | string[]): string[] {
	return Array.isArray(expected) ? expected : [expected]
}

/**
 * Every operation `check` judged among `findings`, once each and in first-seen order. A run-level
 * finding judges no operation and adds none.
 */
export function judgedOperations(findings: readonly Finding[], check: string | null): string[] {
	return [...new Set(findings.filter((item) => item.check === check).flatMap((item) => item.operations ?? []))]
}
