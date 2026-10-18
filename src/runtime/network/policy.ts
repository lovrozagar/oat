/**
 * Network failures are not backend defects.
 *
 * `fetch` throwing is "the request never happened" — DNS, offline, reset, timeout — and must
 * not look like a 4xx/5xx or an uncaught `TypeError: fetch failed`. Classify, retry the blip,
 * then wait once for the link. If it does not come back, one finding names the kind and the
 * rest of the run stands down. This module holds the policy's numbers.
 */

export const DEFAULT_NETWORK_RETRIES = 4
export const DEFAULT_NETWORK_WAIT_MS = 60_000
export const DEFAULT_NETWORK_PROBE_MS = 2_000
/** Per-attempt `AbortSignal` timeout for live `run`. `0` in config disables it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000

/** `undefined` (caller omitted) → default. `0` / non-finite / negative → no timeout. */
export function resolveRequestTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS
	if (!Number.isFinite(value) || value <= 0) return undefined
	return value
}

export function networkRetryWaitMs(attempt: number): number {
	return Math.min(4_000, 250 * 2 ** Math.max(0, attempt))
}
