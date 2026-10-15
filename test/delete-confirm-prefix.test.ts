import { describe, expect, it } from "vitest"
import { judgeDefect } from "../src/conformance/suite.ts"

/*
 * A delete is confirmed by reading its path again. Under an API mounted below a prefix
 * (`/api/...`) that read was sent as the full path from the delete's URL, which the client then
 * put below the base URL a second time: `/api/api/...` answered 404, and a record the delete kept
 * read as removed.
 */

describe("delete.absent-record-returns-404 behind a path prefix", () => {
	it("still catches a delete that keeps its record", async () => {
		const result = await judgeDefect("DELETE_KEEPS_ROW", "memory", "postgrest", "path-prefix")
		expect(result.error).toBeUndefined()
		expect(result.detected).toBe(true)
		expect(result.spurious.map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
	}, 240_000)
})
