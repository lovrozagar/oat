import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../../src/conformance/suite.ts"
import { createMemoryServer } from "../../src/reference/http.ts"
import { run } from "../../src/runtime/run.ts"

/*
 * A client-chosen identity is unique across every tenant, and a principal lists only its own. The
 * seeder avoids the ids it can see; one another tenant holds comes back 409 "taken", and the
 * variant that drew it was lost. Under this nonce the null-heavy table variant draws such an id,
 * and `filter.is-null-selects-nulls` then had no null to test.
 */

describe("seeding with client-chosen identities", () => {
	it("draws a fresh identity when the backend says another record holds it", async () => {
		const server = await createMemoryServer({ shape: "client-ids" })
		try {
			const result = await run({
				baseUrl: server.url,
				nonce: "b7e1c3ac",
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const lost = result.checksSkipped.filter((skip) => skip.needs.includes("failed to seed"))
			expect(lost).toEqual([])
			expect(result.checksRun).toContain("filter.is-null-selects-nulls")
		} finally {
			await server.close()
		}
	}, 60_000)
})
