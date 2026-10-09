import { describe, expect, it } from "vitest"
import { runScopeSuite } from "../src/conformance/scope.ts"

/* Every defect runs in the conformance suite, reusing the defect matrix's full runs; these keep
 * the two ways in — finding the operations itself, and being handed them — under unit test. */
describe("--ops recall", () => {
	it("a run targeted at a defect's operation still reports it", async () => {
		const results = await runScopeSuite(["STALE_LIST", "CROSS_TENANT_READ"])
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results).toHaveLength(2)
	}, 600_000)

	it("sends only the targeted run when the full run's operations are known", async () => {
		const results = await runScopeSuite(["PATCH_REPLACES"], { PATCH_REPLACES: ["table.update"] })
		expect(results.map((r) => r.ok)).toEqual([true])
	}, 600_000)
})
