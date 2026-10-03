import { describe, expect, it } from "vitest"
import { runScopeSuite } from "../src/conformance/scope.ts"

describe("--ops recall", () => {
	it("a run targeted at a defect's operation still reports it, for every defect", async () => {
		const results = await runScopeSuite()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
	}, 600_000)
})
