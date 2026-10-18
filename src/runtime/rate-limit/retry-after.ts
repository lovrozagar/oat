/** How long oat waits before asking again after a 429 or a 503, and how a server error reads. */

/** Extra attempts after the first 429. The first 429 is never a seed/check failure by itself. */
export const MAX_429_RETRIES = 5
export const RETRY_BACKOFF_INITIAL_MS = 1_000
export const RETRY_BACKOFF_CAP_MS = 30_000
/** A 503 that names when to come back is asked again this many times, within this much waiting. */
export const MAX_UNAVAILABLE_RETRIES = 3
/** The pause before a read that met a gateway status (502, 503, 504) is asked once more. */
export const GATEWAY_RETRY_MS = 1_000
export const UNAVAILABLE_WAIT_BUDGET_MS = 60_000

/**
 * How a server error reads in a finding. A 503 that still stood after oat waited out its
 * `Retry-After` is the backend being unavailable, told apart from a crash; both are failures.
 */
export function describeServerError(status: number, retryAfter: string | undefined): string {
	if (status === 0) return "did not answer before the request timed out"
	return status === 503 && retryAfter !== undefined
		? "was unavailable (503) even after waiting out its Retry-After"
		: `answered with a server error (${status})`
}

/**
 * `Retry-After` as a wait in ms. Delta-seconds or HTTP-date; anything unparseable is `null`
 * so the caller can fall back to exponential backoff. Capped so a tester cannot hang for an hour.
 */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
	if (value === undefined) return null
	const trimmed = value.trim()
	if (trimmed === "") return null
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		return Math.min(RETRY_BACKOFF_CAP_MS, Math.max(0, Number(trimmed) * 1000))
	}
	const date = Date.parse(trimmed)
	if (Number.isNaN(date)) return null
	return Math.min(RETRY_BACKOFF_CAP_MS, Math.max(0, date - now))
}

/** Wait before retry `attempt` (0-based) of a 429. Header wins; otherwise 1s, 2s, 4s… capped. */
export function retryWaitMs(retryAfterHeader: string | undefined, attempt: number, now = Date.now()): number {
	const parsed = parseRetryAfter(retryAfterHeader, now)
	if (parsed !== null) return parsed
	const exp = RETRY_BACKOFF_INITIAL_MS * 2 ** Math.max(0, attempt)
	return Math.min(RETRY_BACKOFF_CAP_MS, exp)
}
