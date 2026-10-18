import { describe, expect, it } from "vitest"
import {
	describeServerError,
	GATEWAY_RETRY_MS,
	MAX_429_RETRIES,
	MAX_UNAVAILABLE_RETRIES,
	parseRetryAfter,
	RETRY_BACKOFF_CAP_MS,
	RETRY_BACKOFF_INITIAL_MS,
	retryWaitMs,
	UNAVAILABLE_WAIT_BUDGET_MS,
} from "./retry-after.ts"

const NOW = Date.parse("2030-01-01T00:00:00Z")

describe("retry budgets", () => {
	it("asks a 429 again five times and a 503 three, within a minute", () => {
		expect([MAX_429_RETRIES, MAX_UNAVAILABLE_RETRIES, UNAVAILABLE_WAIT_BUDGET_MS, GATEWAY_RETRY_MS]).toEqual([
			5, 3, 60_000, 1_000,
		])
		expect([RETRY_BACKOFF_INITIAL_MS, RETRY_BACKOFF_CAP_MS]).toEqual([1_000, 30_000])
	})
})

describe("describeServerError", () => {
	it("tells a timeout, an unavailable backend that named its return, and a crash apart", () => {
		expect(describeServerError(0, undefined)).toBe("did not answer before the request timed out")
		expect(describeServerError(503, "5")).toBe("was unavailable (503) even after waiting out its Retry-After")
		expect(describeServerError(503, undefined)).toBe("answered with a server error (503)")
		expect(describeServerError(500, "5")).toBe("answered with a server error (500)")
	})
})

describe("parseRetryAfter", () => {
	it("reads delta-seconds, capped", () => {
		expect(parseRetryAfter(" 2 ", NOW)).toBe(2_000)
		expect(parseRetryAfter("1.5", NOW)).toBe(1_500)
		expect(parseRetryAfter("999", NOW)).toBe(RETRY_BACKOFF_CAP_MS)
		expect(parseRetryAfter("0")).toBe(0)
	})

	it("reads an HTTP date against now, never negative", () => {
		expect(parseRetryAfter("Tue, 01 Jan 2030 00:00:10 GMT", NOW)).toBe(10_000)
		expect(parseRetryAfter("Mon, 31 Dec 2029 23:59:00 GMT", NOW)).toBe(0)
	})

	it("is null when there is nothing to read", () => {
		expect([undefined, "", "   ", "soon"].map((value) => parseRetryAfter(value, NOW))).toEqual([null, null, null, null])
	})
})

describe("retryWaitMs", () => {
	it("waits what the header says, or 1s, 2s, 4s… capped", () => {
		expect(retryWaitMs("3", 4, NOW)).toBe(3_000)
		expect([-1, 0, 1, 2, 10].map((attempt) => retryWaitMs(undefined, attempt, NOW))).toEqual([
			1_000, 1_000, 2_000, 4_000, 30_000,
		])
		expect(retryWaitMs("junk", 0)).toBe(1_000)
	})
})
