import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { run } from "../src/runtime/run.ts"

/* The checks Phase 6 added, each against the defect built for it and against a correct backend. */
const CASES = [
	["CROSS_TENANT_WRITE", "tenant.item-not-writable-cross-tenant"],
	["ROLE_WRITE_INVERTED", "auth.rank-is-monotonic-on-writes"],
	["UNKNOWN_PARAM_EMPTIES_LIST", "query.unknown-parameter-consistent"],
	["PAGE_PAST_END_REPEATS", "pagination.bounds-handled"],
	["FOREIGN_PARENT_ACCEPTED", "tenant.parent-not-reachable-from-another-root"],
] as const

async function findings(defects: string[]): Promise<{ checks: string[]; notes: string[] }> {
	const server = await createMemoryServer({ defects })
	try {
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		return {
			checks: result.findings.filter((f) => f.verdict !== "COVERAGE_GAP").map((f) => f.check),
			notes: result.checkNotes.map((note) => note.note),
		}
	} finally {
		await server.close()
	}
}

describe("checks for cross-tenant writes, rank on writes, unknown parameters and paging bounds", () => {
	for (const [defect, check] of CASES) {
		it(`${check} reports ${defect}`, async () => {
			expect((await findings([defect])).checks).toContain(check)
		}, 120_000)
	}

	it("stay quiet on a correct backend, and say what they observed", async () => {
		const clean = await findings([])
		expect(clean.checks).toEqual([])
		expect(clean.notes).toContain("unknown query parameters are ignored on the listing")
		expect(clean.notes).toContain("a page past the end is served empty")
	}, 120_000)
})
