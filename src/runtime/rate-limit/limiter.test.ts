import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RateLimiter, UNTAGGED_CATEGORY, UNTAGGED_WRITE_CATEGORY } from "./limiter.ts"
import type { CompiledRateLimitRule } from "./rules.ts"

const rule = (category: string, path: string, rps: number): CompiledRateLimitRule => ({
	category,
	rps,
	source: "tag",
	test: (_method, pathname) => pathname === path,
})
const RULES = [rule("reads", "/a", 1), rule("reads", "/b", 1), rule("writes", "/w", 10)]

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("RateLimiter buckets", () => {
	it("resolves a request to the first rule that covers it", () => {
		const limiter = new RateLimiter(RULES)
		expect(limiter.resolve("GET", "/b")?.category).toBe("reads")
		expect(limiter.resolve("GET", "/elsewhere")).toBeUndefined()
	})

	it("paces every rule of one category through one shared bucket", async () => {
		const limiter = new RateLimiter(RULES)
		expect(await limiter.acquire(RULES[0] as CompiledRateLimitRule)).toBe(true)
		const second = limiter.acquire(RULES[1] as CompiledRateLimitRule)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(await second).toBe(false)
		expect(await limiter.acquire(RULES[2] as CompiledRateLimitRule)).toBe(true)
	})

	it("holds every request under the origin's ceiling only when one is set", async () => {
		await expect(new RateLimiter(RULES).acquireCeiling()).resolves.toBeUndefined()
		const limiter = new RateLimiter(RULES, { maxRps: 1 })
		await limiter.acquireCeiling()
		let admitted = false
		const next = limiter.acquireCeiling().then(() => {
			admitted = true
		})
		await vi.advanceTimersByTimeAsync(999)
		expect(admitted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await next
		expect(admitted).toBe(true)
	})
})

describe("RateLimiter after a 429", () => {
	it("penalizes the tagged bucket the request belongs to", async () => {
		const limiter = new RateLimiter(RULES)
		expect(limiter.noteBackoff({ method: "POST", pathname: "/w" }, 2_000)).toBe(RULES[2])
		const held = limiter.acquire(RULES[2] as CompiledRateLimitRule)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(await held).toBe(false)
	})

	it("opens a cooldown for untagged writes and reads, apart", async () => {
		const limiter = new RateLimiter(RULES)
		expect(limiter.implicitRule("POST")).toBeUndefined()
		const opened = limiter.noteBackoff({ method: "post", pathname: "/untagged" }, 1_000)
		expect([opened.category, opened.rps, opened.source]).toEqual([UNTAGGED_WRITE_CATEGORY, 0, "implicit"])
		expect([opened.test("DELETE", "/x"), opened.test("GET", "/x")]).toEqual([true, false])
		limiter.noteBackoff({ method: "PUT", pathname: "/untagged" }, -1)
		const held = limiter.implicitRule("PATCH")
		expect([held?.category, held?.test("PUT", "/x")]).toEqual([UNTAGGED_WRITE_CATEGORY, true])
		expect(limiter.implicitRule("GET")).toBeUndefined()
		expect(limiter.noteBackoff({ method: "GET", pathname: "/untagged" }, 0).category).toBe(UNTAGGED_CATEGORY)
	})

	it("makes a caller wait out the cooldown, and lets it through once it is over", async () => {
		const limiter = new RateLimiter(RULES, { random: () => 0 })
		expect(await limiter.waitImplicit("POST")).toBe(true)
		limiter.noteBackoff({ method: "POST", pathname: "/untagged" }, 1_500)
		const waited = limiter.waitImplicit("PUT")
		await vi.advanceTimersByTimeAsync(1_500)
		expect(await waited).toBe(false)
		expect(await limiter.waitImplicit("PUT")).toBe(true)
	})
})

/* When each waiter leaves, from fake time 0. */
async function leaving(limiter: RateLimiter, waiters: number, drive: () => Promise<unknown>): Promise<number[]> {
	const left: number[] = []
	const waits = Array.from({ length: waiters }, () =>
		limiter.waitImplicit("DELETE").then(() => left.push(performance.now())),
	)
	await drive()
	await Promise.all(waits)
	return left.toSorted((a, b) => a - b)
}

const sequence = (values: number[]) => {
	let next = 0
	return () => values[next++ % values.length] as number
}

describe("RateLimiter releasing writes a 429 held", () => {
	it("spreads them across a window after the cooldown, never all at once, and at most 10 s past it", async () => {
		const limiter = new RateLimiter(RULES, { random: sequence([0.1, 0.3, 0.5, 0.7, 0.9]) })
		limiter.noteBackoff({ method: "DELETE", pathname: "/tables/1" }, 60_000)
		const left = await leaving(limiter, 5, () => vi.advanceTimersByTimeAsync(70_000))
		expect(left).toEqual([61_000, 63_000, 65_000, 67_000, 69_000])
	})

	it("spreads a short cooldown over no more than its own length", async () => {
		const limiter = new RateLimiter(RULES, { random: () => 1 })
		limiter.noteBackoff({ method: "DELETE", pathname: "/tables/1" }, 2_000)
		expect(await leaving(limiter, 1, () => vi.advanceTimersByTimeAsync(10_000))).toEqual([4_000])
	})

	it("keeps the time a cooldown opened when a later 429 extends it", async () => {
		const limiter = new RateLimiter(RULES, { random: () => 1 })
		limiter.noteBackoff({ method: "DELETE", pathname: "/tables/1" }, 2_000)
		await vi.advanceTimersByTimeAsync(1_000)
		limiter.noteBackoff({ method: "DELETE", pathname: "/tables/2" }, 2_000)
		expect(await leaving(limiter, 1, () => vi.advanceTimersByTimeAsync(10_000))).toEqual([6_000])
	})

	it("opens anew from a 429 that comes after the cooldown lapsed", async () => {
		const limiter = new RateLimiter(RULES, { random: () => 1 })
		limiter.noteBackoff({ method: "DELETE", pathname: "/tables/1" }, 2_000)
		await vi.advanceTimersByTimeAsync(5_000)
		limiter.noteBackoff({ method: "DELETE", pathname: "/tables/2" }, 2_000)
		expect(await leaving(limiter, 1, () => vi.advanceTimersByTimeAsync(10_000))).toEqual([9_000])
	})
})
