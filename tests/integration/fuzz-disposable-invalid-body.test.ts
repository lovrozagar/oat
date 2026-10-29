import { describe, expect, it } from "vitest"
import { diagnose } from "../../src/conformance/fuzz/diagnose.ts"
import { optInFor } from "../../src/conformance/matrix/opt-in.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * Combination fuzzing, CI seed 40966542384, combination 478446. DISPOSABLE_KILLS_CALLER's logout revokes
 * the suite caller, so the write target of table.update and row.update (the only operations
 * WRITE_BODY_NOT_VALIDATED reaches) cannot be read back: the caller's credential is BLOCKED. The operation
 * checks behind that target could not complete, and must say so as a BLOCKED check, never stand down as
 * though nothing applied: WRITE_BODY_NOT_VALIDATED is unresolved there, never missed.
 */
const COMBINATION_478446: DefectName[] = [
	"FILTER_DROPPED_WHEN_SORTED_AND_SELECTED",
	"SEARCH_ONLY_FIRST_TOKEN",
	"DISPOSABLE_KILLS_CALLER",
	"WRITE_BODY_NOT_VALIDATED",
]

describe("a fuzz case whose caller a disposable logout revokes, with update bodies left unvalidated", () => {
	it("misses nothing (seed 40966542384, case 478446)", async () => {
		const optIn = optInFor(COMBINATION_478446)
		const server = await createMemoryServer({ defects: COMBINATION_478446, ...optIn.reference })
		try {
			const result = await run({
				...optIn.run,
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const diagnosis = diagnose(COMBINATION_478446, result)
			expect(diagnosis.missed).toEqual([])
			expect(diagnosis.unresolved).toContainEqual({
				defect: "WRITE_BODY_NOT_VALIDATED",
				reason: expect.stringMatching(/^blocked by /),
			})
			expect(diagnosis.ok).toBe(true)
		} finally {
			await server.close()
		}
	}, 240_000)
})
