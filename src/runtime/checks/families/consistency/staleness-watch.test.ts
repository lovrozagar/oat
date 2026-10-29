import { describe, expect, it } from "vitest"
import { exchange } from "../../__fixtures__/harness.ts"
import { watchUntilFresh, type WatchClock } from "./staleness-watch.ts"

/* A clock that moves only when the watch sleeps, and by `perRead` on every read. */
function fakeClock(perRead = 0): WatchClock & { tick: () => void } {
	let now = 1000
	return {
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
		tick: () => {
			now += perRead
		},
	}
}

/* Stale until `freshFrom` ms after the watch starts. */
function source(clock: ReturnType<typeof fakeClock>, freshFrom: number) {
	const start = clock.now()
	return async () => {
		const at = clock.now() - start
		clock.tick()
		return exchange("GET", "/notes/n1", { body: { fresh: at >= freshFrom }, status: 200 })
	}
}
const isFresh = (e: { responseBody: unknown }) => (e.responseBody as { fresh: boolean }).fresh

describe("watchUntilFresh", () => {
	it("costs one read when the first is already fresh", async () => {
		const clock = fakeClock()
		const bracket = await watchUntilFresh({
			capMs: 1000,
			clock,
			fresh: isFresh,
			read: source(clock, 0),
			schedule: [0, 100, 300],
		})
		expect(bracket).toMatchObject({ freshAtMs: 0, reads: 1, stale: null, staleAtMs: null })
	})

	it("brackets the window between the last stale read and the first fresh one", async () => {
		const clock = fakeClock()
		const bracket = await watchUntilFresh({
			capMs: 1000,
			clock,
			fresh: isFresh,
			read: source(clock, 250),
			schedule: [0, 100, 300, 550],
		})
		expect(bracket).toMatchObject({ freshAtMs: 300, reads: 3, staleAtMs: 100 })
		expect(bracket.stale?.status).toBe(200)
	})

	it("stops at the first stale read at or past the cap", async () => {
		const clock = fakeClock()
		const bracket = await watchUntilFresh({
			capMs: 1000,
			clock,
			fresh: isFresh,
			read: source(clock, 5000),
			schedule: [0, 100, 300, 550, 800, 1050],
		})
		expect(bracket).toMatchObject({ freshAtMs: null, reads: 6, staleAtMs: 1050 })
	})
})

describe("watchUntilFresh and a write that never took", () => {
	it("asks once, after the first stale read, whether the write can still show, and stops when it cannot", async () => {
		const clock = fakeClock()
		let asked = 0
		const bracket = await watchUntilFresh({
			capMs: 1000,
			clock,
			fresh: isFresh,
			read: source(clock, 5000),
			schedule: [0, 100, 300, 550, 800, 1050],
			showsPastCache: async () => {
				asked += 1
				return false
			},
		})
		expect(asked).toBe(1)
		expect(bracket).toMatchObject({ freshAtMs: null, neverTook: true, reads: 1, staleAtMs: 0 })
	})

	it("keeps watching when a read past the cache shows the write", async () => {
		const clock = fakeClock()
		const bracket = await watchUntilFresh({
			capMs: 1000,
			clock,
			fresh: isFresh,
			read: source(clock, 250),
			schedule: [0, 100, 300],
			showsPastCache: async () => true,
		})
		expect(bracket).toMatchObject({ freshAtMs: 300, neverTook: false, reads: 3 })
	})

	it("stops early when slow reads carry a stale one past the cap before the schedule ends", async () => {
		const clock = fakeClock(600)
		const bracket = await watchUntilFresh({
			capMs: 1000,
			clock,
			fresh: isFresh,
			read: source(clock, 5000),
			schedule: [0, 100, 300, 550, 800, 1050],
		})
		expect(bracket).toMatchObject({ freshAtMs: null, reads: 3, staleAtMs: 1200 })
	})
})
