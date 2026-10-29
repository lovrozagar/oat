import { describe, expect, it } from "vitest"
import { MAX_STALENESS_READS, stalenessSchedule, UNDECLARED_CAP_MS } from "./staleness-schedule.ts"

describe("stalenessSchedule", () => {
	it("reads at once, then backs off from a tenth of a 1 s bound, each gap at most a quarter of it", () => {
		expect(stalenessSchedule(1000)).toEqual([0, 100, 300, 550, 800, 1050])
	})

	it("doubles from 250 ms to a quarter of a 120 s bound, crossing the bound in 11 reads", () => {
		expect(stalenessSchedule(120_000)).toEqual([0, 250, 750, 1750, 3750, 7750, 15_750, 31_750, 61_750, 91_750, 121_750])
	})

	it("reads an undeclared window for 10 s on the same rule", () => {
		expect(UNDECLARED_CAP_MS).toBe(10_000)
		expect(stalenessSchedule(UNDECLARED_CAP_MS)).toEqual([0, 250, 750, 1750, 3750, 6250, 8750, 11_250])
	})

	it("never reads more than 12 times, however long the bound", () => {
		for (const cap of [1000, 30_000, 600_000, 86_400_000]) {
			expect(stalenessSchedule(cap).length).toBeLessThanOrEqual(MAX_STALENESS_READS)
		}
		expect(MAX_STALENESS_READS).toBe(12)
		expect(stalenessSchedule(86_400_000).at(-1)).toBeLessThan(86_400_000)
	})
})
