import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.ts"
import {
	DEFAULT_MAX_RETRY_AFTER_MS,
	describeServerError,
	describeStatus,
	formatWait,
	GATEWAY_RETRY_MS,
	MAX_429_RETRIES,
	MAX_UNAVAILABLE_RETRIES,
	parseRetryAfter,
	RETRY_BACKOFF_CAP_MS,
	RETRY_BACKOFF_INITIAL_MS,
	retryAfterVerdict,
	retryWaitMs,
} from "./retry-after.ts"

const NOW = Date.parse("2030-01-01T00:00:00Z")

const answered = (status: number, more: Partial<Exchange> = {}): Exchange =>
	({ responseHeaders: {}, status, ...more }) as Exchange

describe("retry budgets", () => {
	it("asks a 429 again five times and a 503 three, waiting at most a minute each by default", () => {
		expect([MAX_429_RETRIES, MAX_UNAVAILABLE_RETRIES, DEFAULT_MAX_RETRY_AFTER_MS, GATEWAY_RETRY_MS]).toEqual([
			5, 3, 60_000, 1_000,
		])
		expect([RETRY_BACKOFF_INITIAL_MS, RETRY_BACKOFF_CAP_MS]).toEqual([1_000, 30_000])
	})
})

describe("describeServerError", () => {
	it("tells a timeout, an unavailable backend that named its return, and a crash apart", () => {
		const named = { responseHeaders: { "retry-after": "5" } }
		expect(describeServerError(answered(0))).toBe("did not answer before the request timed out")
		expect(describeServerError(answered(503, named))).toBe(
			"was unavailable (503) even after waiting out its Retry-After",
		)
		expect(describeServerError(answered(503))).toBe("answered with a server error (503)")
		expect(describeServerError(answered(500, named))).toBe("answered with a server error (500)")
	})

	it("names the wait a 503 asked for past the limit, which oat did not wait out", () => {
		const exceeded = answered(503, {
			responseHeaders: { "retry-after": "86400" },
			retryAfterExceeded: { limitMs: 60_000, waitMs: 86_400_000 },
		})
		expect(describeServerError(exceeded)).toBe(
			"was unavailable (503) and asked oat to wait 24h, longer than network.maxRetryAfterMs (1m)",
		)
	})
})

describe("parseRetryAfter", () => {
	it("reads delta-seconds as the server gave them, however long", () => {
		expect(parseRetryAfter(" 2 ", NOW)).toBe(2_000)
		expect(parseRetryAfter("1.5", NOW)).toBe(1_500)
		expect(parseRetryAfter("999", NOW)).toBe(999_000)
		expect(parseRetryAfter("86400", NOW)).toBe(86_400_000)
		expect(parseRetryAfter("0")).toBe(0)
	})

	it("reads an HTTP date against now, never negative", () => {
		expect(parseRetryAfter("Tue, 01 Jan 2030 00:00:10 GMT", NOW)).toBe(10_000)
		expect(parseRetryAfter("Wed, 02 Jan 2030 00:00:00 GMT", NOW)).toBe(86_400_000)
		expect(parseRetryAfter("Mon, 31 Dec 2029 23:59:00 GMT", NOW)).toBe(0)
	})

	it("is null when there is nothing to read", () => {
		expect([undefined, "", "   ", "soon"].map((value) => parseRetryAfter(value, NOW))).toEqual([null, null, null, null])
	})
})

describe("retryWaitMs", () => {
	it("waits what the header says, or 1s, 2s, 4s… capped", () => {
		expect(retryWaitMs("3", 4, NOW)).toBe(3_000)
		expect(retryWaitMs("45", 0, NOW)).toBe(45_000)
		expect([-1, 0, 1, 2, 10].map((attempt) => retryWaitMs(undefined, attempt, NOW))).toEqual([
			1_000, 1_000, 2_000, 4_000, 30_000,
		])
		expect(retryWaitMs("junk", 0)).toBe(1_000)
	})
})

describe("retryAfterVerdict", () => {
	const minute = 60_000

	it("marks a 429 or a 503 that asks for longer than the limit", () => {
		for (const status of [429, 503]) {
			expect(retryAfterVerdict({ header: "86400", limitMs: minute, status }, NOW)).toEqual({
				limitMs: minute,
				waitMs: 86_400_000,
			})
		}
		expect(retryAfterVerdict({ header: "Wed, 02 Jan 2030 00:00:00 GMT", limitMs: minute, status: 429 }, NOW)).toEqual({
			limitMs: minute,
			waitMs: 86_400_000,
		})
	})

	it("leaves a wait within the limit, another status, and no header unmarked", () => {
		expect(retryAfterVerdict({ header: "45", limitMs: minute, status: 429 }, NOW)).toBeUndefined()
		expect(retryAfterVerdict({ header: "60", limitMs: minute, status: 429 }, NOW)).toBeUndefined()
		expect(retryAfterVerdict({ header: "86400", limitMs: minute, status: 500 }, NOW)).toBeUndefined()
		expect(retryAfterVerdict({ header: undefined, limitMs: minute, status: 429 }, NOW)).toBeUndefined()
		expect(retryAfterVerdict({ header: "soon", limitMs: minute, status: 429 }, NOW)).toBeUndefined()
	})

	it("waits for nothing past zero at a limit of 0", () => {
		expect(retryAfterVerdict({ header: "1", limitMs: 0, status: 429 }, NOW)).toEqual({ limitMs: 0, waitMs: 1_000 })
		expect(retryAfterVerdict({ header: "0", limitMs: 0, status: 429 }, NOW)).toBeUndefined()
	})
})

describe("formatWait", () => {
	it("rounds up to whole seconds, in the largest unit that divides them evenly", () => {
		expect([86_400_000, 90_000, 120_000, 3_600_000, 1_500, 86_399_700, 0].map(formatWait)).toEqual([
			"24h",
			"90s",
			"2m",
			"1h",
			"2s",
			"24h",
			"0s",
		])
	})
})

describe("describeStatus", () => {
	it("is the status, and the wait a 429 or 503 asked for past the limit", () => {
		expect(describeStatus(answered(409))).toBe("409")
		expect(describeStatus(answered(429, { responseHeaders: { "retry-after": "5" } }))).toBe("429")
		expect(describeStatus(answered(429, { retryAfterExceeded: { limitMs: 60_000, waitMs: 86_400_000 } }))).toBe(
			"429 and asked oat to wait 24h, longer than network.maxRetryAfterMs (1m)",
		)
	})
})
