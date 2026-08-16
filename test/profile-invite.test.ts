import { describe, expect, it } from "vitest"
import { runSeedContractSuite } from "../src/conformance/seed-contract.ts"

describe("profile, invite, and auth-provisioned creates", () => {
	it("holds the seed / cheap / invite / register contracts", async () => {
		const results = await runSeedContractSuite()
		const failed = results.filter((r) => !r.ok)
		expect(failed.map((r) => `${r.name}: ${r.detail}`)).toEqual([])
	})
})
