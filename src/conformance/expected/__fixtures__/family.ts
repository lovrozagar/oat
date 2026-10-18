import { expect } from "vitest"
import { isDefectName } from "../../../reference/defects.ts"
import { CHECKS } from "../../../runtime/checks/registry.ts"
import { EXPECTED } from "../table.ts"

/* The run raises these itself while seeding (run/entity/seed-*.ts); they are not registered checks. */
const CHECK_IDS = new Set([...CHECKS.map((check) => check.id), "create.does-not-error", "world.seed"])

/** A family's rows: real defects, each naming registered checks, carried whole into the table. */
export function expectFamily(family: Readonly<Record<string, string | readonly string[]>>): void {
	const rows = Object.entries(family)
	expect(rows.length).toBeGreaterThan(0)
	for (const [defect, ids] of rows) {
		expect(isDefectName(defect), defect).toBe(true)
		const named = typeof ids === "string" ? [ids] : ids
		expect(named.length, defect).toBeGreaterThan(0)
		expect(
			named.filter((id) => !CHECK_IDS.has(id)),
			defect,
		).toEqual([])
		expect(EXPECTED[defect as keyof typeof EXPECTED], defect).toEqual(ids)
	}
}
