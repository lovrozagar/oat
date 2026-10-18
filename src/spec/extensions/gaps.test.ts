import { describe, expect, it } from "vitest"
import { GapCollector } from "./gaps.ts"

describe("gap collector", () => {
	it("records gaps in order", () => {
		const gaps = new GapCollector()
		gaps.record("a.list", "x-query", "first")
		gaps.record("b.read", "x-entity", "second")
		expect(gaps.gaps).toEqual([
			{ detail: "first", operationId: "a.list", tag: "x-query" },
			{ detail: "second", operationId: "b.read", tag: "x-entity" },
		])
	})
})
