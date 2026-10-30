import { describe, expect, it } from "vitest"
import { diagnose } from "../../src/conformance/fuzz/diagnose.ts"
import { optInFor } from "../../src/conformance/matrix/opt-in.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * Combination fuzzing, seed 1872686589, combination 920476. LIMIT_OUT_OF_RANGE_SERVED moves an
 * out-of-range page size into the range, and LIMIT_EXCEEDS_MAX lifts only its ceiling; together the
 * reference served a page size of 0, broke its own documented list envelope (`limit >= 1`), and
 * schema.read-response-matches-document reported it on job, row and table, with no injected defect
 * to justify it. The floor holds whatever happens to the ceiling.
 */
const COMBINATION_920476: DefectName[] = [
	"ANY_SCHEME_ACCEPTED",
	"LIMIT_OUT_OF_RANGE_SERVED",
	"LIMIT_EXCEEDS_MAX",
	"ACTION_CRASHES",
	"FILTER_EQ_NOT_APPLIED",
	"ASYNC_NEVER_COMPLETES",
]

describe("a fuzz case that lifts the page-size ceiling and serves an out-of-range size", () => {
	it("reports nothing the injected defects do not justify (seed 1872686589, case 920476)", async () => {
		const optIn = optInFor(COMBINATION_920476)
		const server = await createMemoryServer({ defects: COMBINATION_920476, ...optIn.reference })
		try {
			const result = await run({
				...optIn.run,
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const diagnosis = diagnose(COMBINATION_920476, result)
			expect(diagnosis.spurious).toEqual([])
			expect(diagnosis.missed).toEqual([])
			expect(diagnosis.ok).toBe(true)
		} finally {
			await server.close()
		}
	}, 240_000)
})
