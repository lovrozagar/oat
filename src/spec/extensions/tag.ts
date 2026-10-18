/**
 * Reads the `x-*` meta tags documented in the README.
 *
 * Every reader follows the same contract: explicit tag → heuristic → `null` plus a recorded
 * gap. oat never silently guesses; an unresolved tag becomes a COVERAGE_GAP in the report
 * naming the tag that would close it.
 */

import type { OperationObject } from "../types.ts"

/** The operation's `key` extension, as the reader expects it to be; `undefined` when absent. */
export function ext<T>(op: OperationObject, key: string): T | undefined {
	const value = (op as Record<string, unknown>)[key]
	return value === undefined ? undefined : (value as T)
}

/** The strings of a list; anything else is none. */
export function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}
