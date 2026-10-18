import { describe, expect, it } from "vitest"
import { loadToolkit } from "./conformance-toolkit.ts"

describe("loadToolkit", () => {
	it("loads every module of the self-test", async () => {
		const toolkit = await loadToolkit()
		expect(typeof toolkit.suite.runParserSuite).toBe("function")
		expect(typeof toolkit.pool.createPool).toBe("function")
		expect(typeof toolkit.defects.isDefectName).toBe("function")
		expect(Object.keys(toolkit).sort()).toEqual(
			[
				"defects",
				"dialect",
				"effects",
				"featureGate",
				"fuzz",
				"pool",
				"rateLimit",
				"seedContract",
				"shapes",
				"suite",
				"unique",
			].sort(),
		)
	})
})
