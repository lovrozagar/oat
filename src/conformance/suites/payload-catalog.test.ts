import { describe, expect, it } from "vitest"
import { runPayloadCatalogSuite } from "./payload-catalog.ts"

describe("runPayloadCatalogSuite", () => {
	it("passes every case", () => {
		const results = runPayloadCatalogSuite()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.length).toBeGreaterThan(0)
	})
})
