import { describe, expect, it } from "vitest"
import { diagnose } from "../../src/conformance/fuzz/diagnose.ts"
import { optInFor } from "../../src/conformance/matrix/opt-in.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * Combination fuzzing, CI seed 40807199544, combination 585000. DISPOSABLE_KILLS_CALLER's logout
 * revokes the suite caller and refuses every fresh sign-in, so auth.privileged-field-ignored cannot
 * send its signup: oat signs the caller in again, is refused, and reports the check BLOCKED, naming
 * it. That is the check saying why it could not conclude, not oat going quiet, and the fuzz must
 * read it so: PRIVILEGED_FIELD_WRITABLE is unresolved there, never missed.
 */
const COMBINATION_585000: DefectName[] = [
	"PRIVILEGED_FIELD_WRITABLE",
	"FILTER_AFTER_PAGINATION",
	"SPEC_OVERCLAIMS_SORTABLE",
	"FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED",
	"REQUIRED_NOT_VALIDATED",
	"DISPOSABLE_KILLS_CALLER",
]

describe("a fuzz case whose primary check is BLOCKED", () => {
	it("reads the check BLOCKED by another defect as unresolved, and misses nothing (seed 40807199544, case 585000)", async () => {
		const optIn = optInFor(COMBINATION_585000)
		const server = await createMemoryServer({ defects: COMBINATION_585000, ...optIn.reference })
		try {
			const result = await run({
				...optIn.run,
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const diagnosis = diagnose(COMBINATION_585000, result)
			expect(diagnosis.missed).toEqual([])
			expect(diagnosis.unresolved).toContainEqual({
				defect: "PRIVILEGED_FIELD_WRITABLE",
				reason: expect.stringMatching(/^blocked by /),
			})
			expect(diagnosis.ok).toBe(true)
		} finally {
			await server.close()
		}
	}, 240_000)
})
