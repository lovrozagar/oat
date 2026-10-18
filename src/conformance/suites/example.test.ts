import { describe, expect, it } from "vitest"
import { runExampleSpecSuite } from "./example.ts"

describe("runExampleSpecSuite", () => {
	it("finds the annotated example modelled as its comments claim", async () => {
		const results = await runExampleSpecSuite()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.length).toBeGreaterThan(10)
	})
})
