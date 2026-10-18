import { describe, expect, it } from "vitest"
import { runParserSuite } from "./parser.ts"

describe("runParserSuite", () => {
	it("passes every case", () => {
		const results = runParserSuite()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.length).toBeGreaterThan(0)
	})
})
