import { afterEach, describe, expect, it, vi } from "vitest"
import { durationMs, nextPollWait, wait } from "./poll.ts"

afterEach(() => {
	vi.useRealTimers()
})

describe("durationMs", () => {
	it("reads milliseconds, seconds and minutes", () => {
		expect(durationMs("500ms")).toBe(500)
		expect(durationMs(" 1.5s ")).toBe(1500)
		expect(durationMs("2m")).toBe(120_000)
	})

	it("refuses anything else", () => {
		expect(() => durationMs("soon")).toThrow('oat: "soon" is not a duration (use 500ms, 30s or 2m)')
	})
})

describe("nextPollWait", () => {
	it("backs off from a short interval up to five seconds", () => {
		expect(nextPollWait(500, 500)).toBe(1_000)
		expect(nextPollWait(4_000, 500)).toBe(5_000)
	})

	it("never polls faster than the interval it asked for", () => {
		expect(nextPollWait(15_000, 15_000)).toBe(15_000)
	})
})

describe("wait", () => {
	it("resolves once the time has passed", async () => {
		vi.useFakeTimers()
		let done = false
		const waiting = wait(1_000).then(() => {
			done = true
		})
		await vi.advanceTimersByTimeAsync(999)
		expect(done).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await waiting
		expect(done).toBe(true)
	})
})
