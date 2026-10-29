import { describe, expect, it } from "vitest"
import { diagnose } from "../../src/conformance/fuzz/diagnose.ts"
import { optInFor } from "../../src/conformance/matrix/opt-in.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * Combination fuzzing, CI seed 40949788323, combination 742515. ROLE_WRITE_INVERTED refuses every
 * update the member sends, so auth.privileged-field-ignored's member probe drew 403 for a reason that
 * had nothing to do with the marked field, read the untouched record, and passed: PRIVILEGED_FIELD_WRITABLE
 * was missed. A writer refused even its harmless write gives way to the next rank below the top, and the
 * viewer, whom the inverted lattice lets update, sets the field.
 */
const COMBINATION_742515: DefectName[] = [
	"FILTER_ILIKE_IS_LIKE",
	"PRIVILEGED_FIELD_WRITABLE",
	"ROLE_WRITE_INVERTED",
	"ACTION_CRASHES",
	"FILTER_AFTER_PAGINATION",
	"NESTED_SELECT_IGNORED",
]

describe("a fuzz case whose privileged writer cannot update at all", () => {
	it("finds the privileged field through a rank that can write (seed 40949788323, case 742515)", async () => {
		const optIn = optInFor(COMBINATION_742515)
		const server = await createMemoryServer({ defects: COMBINATION_742515, ...optIn.reference })
		try {
			const result = await run({
				...optIn.run,
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const diagnosis = diagnose(COMBINATION_742515, result)
			expect(diagnosis.missed).toEqual([])
			expect(result.findings.map((finding) => finding.check)).toContain("auth.privileged-field-ignored")
			expect(diagnosis.ok).toBe(true)
		} finally {
			await server.close()
		}
	}, 240_000)
})
