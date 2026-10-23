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

/** A tag whose value is an object, as every structured x-* tag is; anything else (`null`, a string) is absent. */
export function extObject(op: OperationObject, key: string): Record<string, unknown> | undefined {
	const value = (op as Record<string, unknown>)[key]
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

/** The strings of a list; anything else is none. */
export function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}
