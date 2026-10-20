import { describe, expect, it } from "vitest"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * A delete is confirmed by reading its path again. When that read is refused — the caller's
 * session was ended by a destructive call that should have spared it — it shows nothing about the
 * record, and oat went quiet: a delete that kept its row was neither found nor reported as
 * unjudged (conformance fuzz, DELETE_KEEPS_ROW with DISPOSABLE_KILLS_CALLER). A caller the server
 * refuses everywhere is BLOCKED once a control read shows it, and the check says so: the read-back
 * it could not send, and why.
 */

describe("delete.absent-record-returns-404 when the read-back is refused", () => {
	it("says it could not see whether the record is gone", async () => {
		const server = await createMemoryServer({ defects: ["DELETE_KEEPS_ROW", "DISPOSABLE_KILLS_CALLER"] })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const judged = result.findings.some((finding) => finding.check === "delete.absent-record-returns-404")
			const unjudged = result.inconclusive.filter((entry) => entry.check === "delete.absent-record-returns-404")
			const blocked = result.findings.filter(
				(finding) => finding.check === "auth.blocked" && finding.summary.startsWith("delete.absent-record-returns-404"),
			)
			expect(judged || unjudged.length > 0 || blocked.length > 0).toBe(true)
			const why = judged ? "judged" : (unjudged[0]?.reason ?? blocked[0]?.detail)
			expect(why).toMatch(/^judged$|answered 40[13]|was not sent to read .+ back after/)
		} finally {
			await server.close()
		}
	}, 240_000)
})
