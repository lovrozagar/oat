/**
 * Reads the `x-*` meta tags documented in the README.
 *
 * Every reader follows the same contract: explicit tag → heuristic → `null` plus a recorded
 * gap. oat never silently guesses; an unresolved tag becomes a COVERAGE_GAP in the report
 * naming the tag that would close it.
 */

import type { RawOf } from "../../config/types/raw.ts"
import { isObject } from "../tags/checks.ts"
import type { OperationObject } from "../types.ts"

/** The operation's `key` extension as it stands; `undefined` when absent. */
export function ext(op: OperationObject, key: string): unknown {
	return (op as Record<string, unknown>)[key]
}

/** The operation's `key` extension when it is an object with the fields of `T`, each unread; else `undefined`. */
export function extObject<T>(op: OperationObject, key: string): RawOf<T> | undefined {
	const value = ext(op, key)
	return isObject(value) ? value : undefined
}

/** The strings of a list; anything else is none. */
export function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}
