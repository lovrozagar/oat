import { describe, expect, it } from "vitest"
import {
	MAX_STALENESS_READS,
	MAX_WATCH_MS,
	stalenessSchedule,
	UNDECLARED_CAP_MS,
	watchCapMs,
} from "./staleness-schedule.ts"

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

	it("always ends at the cap, even where twelve doubling reads fall short of it", () => {
		const tenMinutes = stalenessSchedule(MAX_WATCH_MS)
		expect(tenMinutes).toHaveLength(12)
		expect(tenMinutes.at(-1)).toBe(600_000)
		expect(tenMinutes.at(-2)).toBeLessThan(600_000)
	})

	it("watches 10 minutes at most, whatever the bound declares", () => {
		expect(MAX_WATCH_MS).toBe(600_000)
		expect(watchCapMs(86_400_000)).toBe(600_000)
		expect(watchCapMs(1000)).toBe(1000)
		expect(watchCapMs(null)).toBe(UNDECLARED_CAP_MS)
	})

	it("never reads more than 12 times, however long the bound", () => {
		for (const cap of [1000, 30_000, 600_000, 86_400_000]) {
			expect(stalenessSchedule(cap).length).toBeLessThanOrEqual(MAX_STALENESS_READS)
		}
		expect(MAX_STALENESS_READS).toBe(12)
		expect(stalenessSchedule(86_400_000).at(-1)).toBe(86_400_000)
	})
})
