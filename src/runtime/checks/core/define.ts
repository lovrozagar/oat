import type { Check } from "./check.ts"
import { validateRegistry } from "./registry.ts"

/*
 * Every check is made by `defineCheck` and every registry by `buildRegistry`. A check's family is
 * its id's prefix (check-ids.ts), so it is not stated twice.
 */

/** A check, typed by what its plan hands its run. */
export function defineCheck<T = unknown>(check: Check<T>): Check<T> {
	return check
}

/** The registry in run order, refused unless every id is there once and each dependency runs first. */
export function buildRegistry(checks: readonly Check[]): readonly Check[] {
	validateRegistry(checks)
	return checks
}
