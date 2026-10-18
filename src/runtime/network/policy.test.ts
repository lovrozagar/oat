import { describe, expect, it } from "vitest"
import {
	DEFAULT_NETWORK_PROBE_MS,
	DEFAULT_NETWORK_RETRIES,
	DEFAULT_NETWORK_WAIT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	networkRetryWaitMs,
	resolveRequestTimeoutMs,
} from "./policy.ts"

describe("network policy", () => {
	it("retries four times, waits a minute for the link, probes every two seconds", () => {
		expect([DEFAULT_NETWORK_RETRIES, DEFAULT_NETWORK_WAIT_MS, DEFAULT_NETWORK_PROBE_MS]).toEqual([4, 60_000, 2_000])
	})

	it("times a request out after the default unless the caller turns it off", () => {
		expect(resolveRequestTimeoutMs(undefined)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
		expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(180_000)
		expect(resolveRequestTimeoutMs(500)).toBe(500)
		for (const off of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(resolveRequestTimeoutMs(off)).toBeUndefined()
	})

	it("backs off exponentially from 250ms, capped at four seconds", () => {
		expect([-1, 0, 1, 2, 4, 10].map(networkRetryWaitMs)).toEqual([250, 250, 500, 1_000, 4_000, 4_000])
	})
})
