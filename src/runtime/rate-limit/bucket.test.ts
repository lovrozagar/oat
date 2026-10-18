import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RateBucket } from "./bucket.ts"

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
})

afterEach(() => {
	vi.useRealTimers()
})

/** Settles `pending` by moving the clock `ms`, and says how long it took. */
async function settle<T>(pending: Promise<T>, ms: number): Promise<{ value: T; waited: number }> {
	const began = performance.now()
	await vi.advanceTimersByTimeAsync(ms)
	return { value: await pending, waited: performance.now() - began }
}

describe("RateBucket", () => {
	it("admits a burst of rps at once, then paces the next to its share of a second", async () => {
		const bucket = new RateBucket(2)
		expect(await bucket.acquire()).toBe(true)
		expect(await bucket.acquire()).toBe(true)
		const third = await settle(bucket.acquire(), 500)
		expect(third).toEqual({ value: false, waited: 500 })
	})

	it("refills with time, up to the burst", async () => {
		const bucket = new RateBucket(2)
		await bucket.acquire()
		await bucket.acquire()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(await bucket.acquire()).toBe(true)
		expect(await bucket.acquire()).toBe(true)
		expect((await settle(bucket.acquire(), 500)).value).toBe(false)
	})

	it("admits concurrent callers one at a time, in order", async () => {
		const bucket = new RateBucket(1)
		const order: number[] = []
		const all = Promise.all([1, 2, 3].map((n) => bucket.acquire().then((room) => order.push(n) && room)))
		const { value } = await settle(all, 2_000)
		expect(value).toEqual([true, false, false])
		expect(order).toEqual([1, 2, 3])
	})

	it("holds the next caller through a 429's cooldown, then admits exactly one", async () => {
		const bucket = new RateBucket(5)
		bucket.penalize(1_000)
		bucket.penalize(-5)
		const held = await settle(bucket.acquire(), 1_000)
		expect(held).toEqual({ value: false, waited: 1_000 })
		expect((await settle(bucket.acquire(), 200)).value).toBe(false)
	})
})
