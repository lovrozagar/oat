import { describe, expect, it } from "vitest"
import {
	DEFAULT_OUT_OF_BAND,
	backoffDelays,
	isAbsentValue,
	pollWithBackoff,
	resolveBackoff,
	worstCaseWaitMs,
} from "../src/runtime/poll.ts"

describe("outOfBand backoff", () => {
	it("keeps 0.6.2 defaults and a 9s worst-case wait", () => {
		expect(resolveBackoff()).toEqual(DEFAULT_OUT_OF_BAND)
		expect(resolveBackoff({})).toEqual(DEFAULT_OUT_OF_BAND)
		expect(backoffDelays(DEFAULT_OUT_OF_BAND)).toEqual([200, 400, 800, 1600, 3000, 3000])
		expect(worstCaseWaitMs()).toBe(9000)
		expect(worstCaseWaitMs(undefined)).toBe(9000)
	})

	it("documents the 20 / 1000 / 8000 schedule", () => {
		const config = { attempts: 20, initialMs: 1000, maxMs: 8000 }
		expect(worstCaseWaitMs(config)).toBe(143_000)
	})

	it("rejects non-positive numbers", () => {
		expect(resolveBackoff({ attempts: 0, initialMs: -1, maxMs: Number.NaN })).toEqual(DEFAULT_OUT_OF_BAND)
		expect(resolveBackoff({ attempts: 2.9, initialMs: 10.8, maxMs: 20.2 })).toEqual({
			attempts: 2,
			initialMs: 10,
			maxMs: 20,
		})
	})

	it("treats null and empty string as absent", () => {
		expect(isAbsentValue(null)).toBe(true)
		expect(isAbsentValue("")).toBe(true)
		expect(isAbsentValue("tok")).toBe(false)
		expect(isAbsentValue(0)).toBe(false)
	})

	it("returns on the first occupied value and does not sleep", async () => {
		const attempts: number[] = []
		const value = await pollWithBackoff(
			async (attempt) => {
				attempts.push(attempt)
				return "ready"
			},
			{ attempts: 3, initialMs: 50, maxMs: 50 },
		)
		expect(value).toBe("ready")
		expect(attempts).toEqual([1])
	})

	it("retries null and empty string then returns", async () => {
		const seen: Array<string | null> = []
		const value = await pollWithBackoff(
			async (attempt) => {
				if (attempt === 1) {
					seen.push(null)
					return null
				}
				if (attempt === 2) {
					seen.push("")
					return ""
				}
				seen.push("ok")
				return "ok"
			},
			{ attempts: 4, initialMs: 1, maxMs: 1 },
		)
		expect(value).toBe("ok")
		expect(seen).toEqual([null, "", "ok"])
	})

	it("returns undefined after every miss", async () => {
		const value = await pollWithBackoff(async () => null, { attempts: 2, initialMs: 1, maxMs: 1 })
		expect(value).toBeUndefined()
	})
})
