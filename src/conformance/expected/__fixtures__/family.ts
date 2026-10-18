import { expect } from "vitest"
import { isDefectName } from "../../../reference/defects/table.ts"
import { RUN_FINDING_IDS } from "../../../runtime/check-ids.ts"
import { CHECKS } from "../../../runtime/checks/registry.ts"
import { EXPECTED } from "../table.ts"

/* A row names a registered check, or a finding the run raises itself. */
const FINDING_IDS = new Set<string>([...CHECKS.map((check) => check.id), ...RUN_FINDING_IDS])

/** A family's rows: real defects, each naming registered checks, carried whole into the table. */
export function expectFamily(family: Readonly<Record<string, string | readonly string[]>>): void {
	const rows = Object.entries(family)
	expect(rows.length).toBeGreaterThan(0)
	for (const [defect, ids] of rows) {
		expect(isDefectName(defect), defect).toBe(true)
		const named = typeof ids === "string" ? [ids] : ids
		expect(named.length, defect).toBeGreaterThan(0)
		expect(
			named.filter((id) => !FINDING_IDS.has(id)),
			defect,
		).toEqual([])
		expect(EXPECTED[defect as keyof typeof EXPECTED], defect).toEqual(ids)
	}
}
