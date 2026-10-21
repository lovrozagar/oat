import type { Check, OperationCheck, RegisteredCheck } from "./check.ts"
import { validateRegistry } from "./registry.ts"

/*
 * Every check is made by `defineCheck` and every registry by `buildRegistry`. A check's family is
 * its id's prefix (check-ids.ts), so it is not stated twice.
 */

/** A check, typed by what its plan hands its run: an entity check, or one with `subject: "operation"`. */
export function defineCheck<T = unknown>(check: Check<T>): Check<T>
export function defineCheck<T = unknown>(check: OperationCheck<T>): OperationCheck<T>
export function defineCheck<T>(check: Check<T> | OperationCheck<T>): Check<T> | OperationCheck<T> {
	return check
}

/** The registry in run order, refused unless every id is there once and each dependency runs first. */
export function buildRegistry<C extends RegisteredCheck>(checks: readonly C[]): readonly C[] {
	validateRegistry(checks)
	return checks
}
