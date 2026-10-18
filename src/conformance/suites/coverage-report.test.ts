import { describe, expect, it } from "vitest"
import { runCoverageReportSuite } from "./coverage-report.ts"

describe("runCoverageReportSuite", () => {
	it("passes every case", () => {
		const results = runCoverageReportSuite()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.length).toBeGreaterThan(0)
	})
})
