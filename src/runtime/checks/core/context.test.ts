import { describe, expect, it } from "vitest"
import { checkMemo } from "./context.ts"

describe("checkMemo", () => {
	it("gives each entity a fresh table and shares the run's", () => {
		const run = new Map<string, unknown>()
		const first = checkMemo(run)
		const second = checkMemo(run)
		first.entity.set("fact", 1)
		first.run.set("read", 2)
		expect(second.entity.has("fact")).toBe(false)
		expect(second.run.get("read")).toBe(2)
	})

	it("makes its own run table when none is given", () => {
		expect(checkMemo().run.size).toBe(0)
	})
})
