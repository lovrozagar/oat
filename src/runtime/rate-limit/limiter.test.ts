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
		const limiter = new RateLimiter(RULES)
		expect(await limiter.waitImplicit("POST")).toBe(true)
		limiter.noteBackoff({ method: "POST", pathname: "/untagged" }, 1_500)
		const waited = limiter.waitImplicit("PUT")
		await vi.advanceTimersByTimeAsync(1_500)
		expect(await waited).toBe(false)
		expect(await limiter.waitImplicit("PUT")).toBe(true)
	})
})
