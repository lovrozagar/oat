import { describe, expect, it } from "vitest"
import { inProcess } from "../../src/conformance/harness/launch.ts"
import { judgeDefect } from "../../src/conformance/matrix/cases.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"

/*
 * The precondition defects, each judged as the conformance matrix judges it, against the reference in
 * process: the defect must trip its primary check and nothing the expected table does not accept.
 * The ETag one runs again where the update is a PUT and where the document declares status ranges,
 * the two shapes whose update and read the precondition is declared on differently.
 */

const CASES: ReadonlyArray<[DefectName, string | undefined]> = [
	["ETAG_IGNORED", undefined],
	["PROBLEM_JSON_MALFORMED", undefined],
	["ETAG_IGNORED", "put-update"],
	["ETAG_IGNORED", "range-statuses"],
]

describe("the precondition defects", () => {
	it.each(CASES)(
		"%s fires its check in process (shape %s), and nothing else",
		async (defect, shape) => {
			const judged = await judgeDefect(defect, { backend: "memory", dialect: "postgrest", shape, via: inProcess })
			expect(judged.error).toBeUndefined()
			expect(judged.detected).toBe(true)
			expect(judged.spurious).toEqual([])
			expect(judged.checksRun).toContain(judged.expected)
		},
		240_000,
	)
})
