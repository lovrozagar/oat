import { CHECK_IDS } from "../../check-ids.ts"
import type { Check } from "./check.ts"

/**
 * Checked when a run starts, before anything is sent: ids are unique, every id is one `CheckId` names, and
 * every dependency is registered earlier. A dependency registered later can never suppress
 * anything — it has not run yet when the scheduler consults it.
 */
export function validateRegistry(checks: readonly Check[]): void {
	const position = new Map<string, number>()
	for (const [index, check] of checks.entries()) {
		if (position.has(check.id)) throw new Error(`check "${check.id}" is registered twice`)
		position.set(check.id, index)
	}
	for (const id of CHECK_IDS) {
		if (!position.has(id)) throw new Error(`check "${id}" is named in CHECK_IDS but never registered`)
	}
	for (const [index, check] of checks.entries()) {
		for (const dependency of check.dependsOn ?? []) {
			const at = position.get(dependency)
			if (at === undefined) throw new Error(`check "${check.id}" depends on "${dependency}", which is not registered`)
			if (at >= index) {
				throw new Error(`check "${check.id}" depends on "${dependency}", which is registered after it`)
			}
		}
	}
}
