import { describe, expect, it } from "vitest"
import { diagnose } from "../../src/conformance/fuzz/diagnose.ts"
import { optInFor } from "../../src/conformance/matrix/opt-in.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * Combination fuzzing, seed 3619860453, combination 130110. IGNORES_MALFORMED_FILTER drops unparsable
 * syntax with a 200, so error.malformed-filter-not-5xx's garbage probe never reached a refusal and
 * passed; ERROR_500_ON_BAD_FILTER was missed, while the over-limit in() and the condition cap, which
 * the defect turns into 500s too, reported that crash on their own. A well-formed filter on a field
 * the entity lacks still has to be refused, and draws the defect's 500.
 */
const COMBINATION_130110: DefectName[] = [
	"SEARCH_EMPTY_MATCHES_NONE",
	"IGNORES_MALFORMED_FILTER",
	"UNKNOWN_PARAM_EMPTIES_LIST",
	"ERROR_500_ON_BAD_FILTER",
]

describe("a fuzz case whose backend drops garbage filters and crashes on refused ones", () => {
	it("finds the crash and reports nothing unjustified (seed 3619860453, case 130110)", async () => {
		const optIn = optInFor(COMBINATION_130110)
		const server = await createMemoryServer({ defects: COMBINATION_130110, ...optIn.reference })
		try {
			const result = await run({
				...optIn.run,
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const diagnosis = diagnose(COMBINATION_130110, result)
			expect(diagnosis.spurious).toEqual([])
			expect(diagnosis.missed).toEqual([])
			expect(result.findings.map((finding) => finding.check)).toContain("error.malformed-filter-not-5xx")
			expect(diagnosis.ok).toBe(true)
		} finally {
			await server.close()
		}
	}, 240_000)
})
