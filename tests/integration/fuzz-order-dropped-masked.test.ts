import { describe, expect, it } from "vitest"
import { diagnose } from "../../src/conformance/fuzz/diagnose.ts"
import { optInFor } from "../../src/conformance/matrix/opt-in.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * Combination fuzzing, seed 37515861865, combination 561375. ORDER_DROPPED_WHEN_SELECTED falls back to
 * the implicit order once a select is present; DEFAULT_ORDER_IGNORED empties it and TIEBREAK_NOT_APPLIED
 * leaves a text tiebreak, so the dropped order came back ascending by the very field asked for, and
 * query.sort-and-select-compose passed. An order that ascends whatever is asked fails descending.
 */
const COMBINATION_561375: DefectName[] = [
	"LIST_DETAIL_DISAGREE",
	"SCOPE_NOT_CHECKED",
	"ORDER_DROPPED_WHEN_SELECTED",
	"TIEBREAK_NOT_APPLIED",
	"DEFAULT_ORDER_IGNORED",
]

describe("a fuzz case whose dropped order happens to ascend by the sort field", () => {
	it("finds the order dropped under a select (seed 37515861865, case 561375)", async () => {
		const optIn = optInFor(COMBINATION_561375)
		const server = await createMemoryServer({ defects: COMBINATION_561375, ...optIn.reference })
		try {
			const result = await run({
				...optIn.run,
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const diagnosis = diagnose(COMBINATION_561375, result)
			expect(diagnosis.missed).toEqual([])
			expect(diagnosis.spurious).toEqual([])
			expect(result.findings.map((finding) => finding.check)).toContain("query.sort-and-select-compose")
			expect(diagnosis.ok).toBe(true)
		} finally {
			await server.close()
		}
	}, 240_000)
})
