import { isDefectName } from "../../../reference/defects/table.ts"
import { RUN_FINDING_IDS } from "../../../runtime/check-ids.ts"
import { CHECKS } from "../../../runtime/checks/registry.ts"
import { EXPECTED } from "../table.ts"

/** Whether a row names a registered check, or a finding the run raises itself. */
function isFindingId(id: string): boolean {
	return CHECKS.some((check) => check.id === id) || (RUN_FINDING_IDS as readonly string[]).includes(id)
}

/** What is wrong with one row: a real defect, naming registered checks, carried whole into the table. */
function rowProblems(defect: string, ids: string | readonly string[]): string[] {
	const named = typeof ids === "string" ? [ids] : ids
	const problems: string[] = []
	if (!isDefectName(defect)) problems.push(`${defect}: not a defect`)
	if (named.length === 0) problems.push(`${defect}: names no check`)
	for (const id of named.filter((name) => !isFindingId(name))) problems.push(`${defect}: ${id} is not a check`)
	if (JSON.stringify(EXPECTED[defect as keyof typeof EXPECTED]) !== JSON.stringify(ids))
		problems.push(`${defect}: not carried into the table`)
	return problems
}

/** A family's problems: none when it has rows and every row holds. */
export function familyProblems(family: Readonly<Record<string, string | readonly string[]>>): string[] {
	const rows = Object.entries(family)
	if (rows.length === 0) return ["the family is empty"]
	return rows.flatMap(([defect, ids]) => rowProblems(defect, ids))
}
