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
	it("blocks the caller the server refuses everywhere, and names the read-back it could not send", async () => {
		const server = await createMemoryServer({ defects: ["DELETE_KEEPS_ROW", "DISPOSABLE_KILLS_CALLER"] })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const own = (check: string) => result.findings.filter((finding) => finding.check === check)
			const blocked = own("auth.blocked").filter((finding) =>
				finding.summary.startsWith("delete.absent-record-returns-404"),
			)
			expect(own("delete.absent-record-returns-404")).toEqual([])
			expect(result.inconclusive.filter((entry) => entry.check === "delete.absent-record-returns-404")).toEqual([])
			expect(blocked.map((finding) => [finding.entity, finding.operations])).toEqual([
				["row", ["row.delete"]],
				["job", ["job.delete"]],
				["webhook", ["webhook.delete"]],
				["api-key", ["apiKey.revoke"]],
			])
			for (const finding of blocked) {
				expect(finding.detail).toMatch(
					/^blocked by signed in again, and the new credential is refused where the old one was accepted \((job|profile|webhook|apiKey)\.get\)\. (row|job|webhook|apiKey)\.get was not sent to read \S+ back after ((row|job|webhook)\.delete|apiKey\.revoke)\.$/,
				)
			}
		} finally {
			await server.close()
		}
	}, 240_000)
})
