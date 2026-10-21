import { CHECK_IDS } from "../../check-ids.ts"
import type { Check, OperationCheck, RegisteredCheck } from "./check.ts"

/**
 * Checked when a run starts, before anything is sent: ids are unique, every id is one `CheckId` names, and
 * every dependency is registered earlier. A dependency registered later can never suppress
 * anything — it has not run yet when the scheduler consults it.
 */
export function validateRegistry(checks: readonly RegisteredCheck[]): void {
	const position = new Map<string, number>()
	for (const [index, check] of checks.entries()) {
		if (position.has(check.id)) throw new Error(`check "${check.id}" is registered twice`)
		position.set(check.id, index)
	}
	for (const id of CHECK_IDS) {
		if (!position.has(id)) throw new Error(`check "${id}" is named in CHECK_IDS but never registered`)
	}
	/* Only an entity check has dependencies: an operation check stands alone on its operation. */
	for (const check of entityChecks(checks)) {
		for (const dependency of check.dependsOn ?? []) {
			const at = position.get(dependency)
			if (at === undefined) throw new Error(`check "${check.id}" depends on "${dependency}", which is not registered`)
			if (at >= (position.get(check.id) as number)) {
				throw new Error(`check "${check.id}" depends on "${dependency}", which is registered after it`)
			}
		}
	}
}

/** The registry's entity checks, in registry order: what an entity's check loop runs. */
export function entityChecks(checks: readonly RegisteredCheck[]): Check[] {
	return checks.filter((check): check is Check => check.subject !== "operation")
}

/** The registry's operation checks, in registry order: what the security stage runs. */
export function operationChecks(checks: readonly RegisteredCheck[]): OperationCheck[] {
	return checks.filter((check): check is OperationCheck => check.subject === "operation")
}
