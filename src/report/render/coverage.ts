import type { ReportInput } from "./input.ts"

/** How far one check got across the tested entities. */
export interface CheckCoverage {
	check: string
	needs: string
	ran: number
	skipped: number
	blocked: number
	skippedEntities: string[]
	blockedEntities: string[]
}

/** Per check, how far it got: the three ways a check falls short of running everywhere. */
export interface Coverage {
	never: CheckCoverage[]
	partialSkip: CheckCoverage[]
	blocked: CheckCoverage[]
}

/**
 * The checks that did not run everywhere: never applicable, applicable only on some entities, or
 * blocked by an earlier failure. Sorted by check id.
 */
export function coverageByCheck(input: ReportInput): Coverage {
	const tested = input.entitiesTested.length
	const rows = new Map<string, CheckCoverage>()
	const row = (check: string, needs: string): CheckCoverage => {
		const existing = rows.get(check)
		if (existing !== undefined) return existing
		const created: CheckCoverage = {
			blocked: 0,
			blockedEntities: [],
			check,
			needs,
			ran: 0,
			skipped: 0,
			skippedEntities: [],
		}
		rows.set(check, created)
		return created
	}
	for (const entry of input.checksSkipped ?? []) {
		const current = row(entry.check, entry.needs)
		current.skipped += 1
		current.skippedEntities.push(entry.entity)
	}
	for (const entry of input.checksSuppressed ?? []) {
		const current = row(entry.check, "a check it depends on already failed")
		current.blocked += 1
		current.blockedEntities.push(entry.entity)
	}
	const outOfScope = new Map<string, number>()
	for (const entry of input.checksOutOfScope ?? []) outOfScope.set(entry.check, (outOfScope.get(entry.check) ?? 0) + 1)
	for (const current of rows.values()) {
		current.ran = Math.max(0, tested - current.skipped - current.blocked - (outOfScope.get(current.check) ?? 0))
	}
	const all = [...rows.values()].sort((a, b) => a.check.localeCompare(b.check))
	return {
		blocked: all.filter((item) => item.blocked > 0),
		never: all.filter((item) => item.ran === 0 && item.blocked === 0 && item.skipped > 0),
		partialSkip: all.filter((item) => item.ran > 0 && item.skipped > 0),
	}
}

/**
 * One line naming what `--profile` narrowed and why — silently shrinking coverage is the failure
 * mode to avoid, so a gated run says exactly what it skipped, the same way a coverage gap does.
 * `null` on the default `"full"` profile with nothing excluded: nothing to say.
 */
export function profileExclusionSummary(input: ReportInput): string | null {
	const exclusions = input.profileExclusions ?? []
	if (exclusions.length === 0) return null
	const highCost = exclusions.filter((e) => e.reason.startsWith("x-cost")).length
	const destructive = exclusions.filter((e) => e.reason === "x-destructive").length
	const byName = exclusions.length - highCost - destructive
	const parts = [
		highCost > 0 ? `${highCost} high-cost` : null,
		destructive > 0 ? `${destructive} destructive` : null,
		byName > 0 ? `${byName} excluded by name` : null,
	].filter((part): part is string => part !== null)
	/* The three counts sum to the exclusions, so at least one part is there. */
	return `skipped ${exclusions.length} operation(s) under --profile ${input.profile ?? "?"} (${parts.join(", ")})`
}
