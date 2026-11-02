/** How long oat waits before asking again after a 429 or a 503, and how a server error reads. */

import type { Exchange, RetryAfterExceeded } from "../exchange.ts"
import { headerValue } from "../headers.ts"

/** Extra attempts after the first 429. The first 429 is never a seed/check failure by itself. */
export const MAX_429_RETRIES = 5
export const RETRY_BACKOFF_INITIAL_MS = 1_000
/** The longest backoff oat picks itself, when the server names no wait. */
export const RETRY_BACKOFF_CAP_MS = 30_000
/** A 503 that names when to come back is asked again this many times. */
export const MAX_UNAVAILABLE_RETRIES = 3
/** The pause before a read that met a gateway status (502, 503, 504) is asked once more. */
export const GATEWAY_RETRY_MS = 1_000
/** The longest `Retry-After` oat waits out unless `network.maxRetryAfterMs` says otherwise. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000

/* Statuses whose `Retry-After` oat waits out. */
const WAITED_STATUSES: ReadonlySet<number> = /* @__PURE__ */ new Set([429, 503])

/**
 * How a server error reads in a finding. A 503 that still stood after oat waited out its
 * `Retry-After` is the backend being unavailable, told apart from a crash; both are failures.
 */
export function describeServerError(
	exchange: Pick<Exchange, "status" | "responseHeaders" | "retryAfterExceeded">,
): string {
	const { status, retryAfterExceeded } = exchange
	if (status === 0) return "did not answer before the request timed out"
	if (status !== 503 || headerValue(exchange.responseHeaders, "retry-after") === undefined) {
		return `answered with a server error (${status})`
	}
	return retryAfterExceeded === undefined
		? "was unavailable (503) even after waiting out its Retry-After"
		: `was unavailable (503) and ${describeExceeded(retryAfterExceeded)}`
}

/** An answer's status, and the wait it asked for when oat would not wait that long: "429 and asked oat to wait 24h, …". */
export function describeStatus(exchange: Pick<Exchange, "status" | "retryAfterExceeded">): string {
	const { status, retryAfterExceeded } = exchange
	return retryAfterExceeded === undefined ? String(status) : `${status} and ${describeExceeded(retryAfterExceeded)}`
}

/** "asked oat to wait 24h, longer than network.maxRetryAfterMs (60s)": the wait oat did not wait out. */
export function describeExceeded(exceeded: RetryAfterExceeded): string {
	return `asked oat to wait ${formatWait(exceeded.waitMs)}, longer than network.maxRetryAfterMs (${formatWait(exceeded.limitMs)})`
}

/** A wait in whole seconds, rounded up, written in the largest unit that divides it evenly. */
export function formatWait(ms: number): string {
	const seconds = Math.ceil(ms / 1000)
	if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600}h`
	if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}m`
	return `${seconds}s`
}

/**
 * `Retry-After` as a wait in ms, as long as the server asked. Delta-seconds or HTTP-date; anything
 * unparseable is `null` so the caller can fall back to exponential backoff.
 */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | null {
	if (value === undefined) return null
	const trimmed = value.trim()
	if (trimmed === "") return null
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000)
	const date = Date.parse(trimmed)
	if (Number.isNaN(date)) return null
	return Math.max(0, date - now)
}

/** Wait before retry `attempt` (0-based) of a 429. Header wins; otherwise 1s, 2s, 4s… capped. */
export function retryWaitMs(retryAfterHeader: string | undefined, attempt: number, now: number = Date.now()): number {
	const parsed = parseRetryAfter(retryAfterHeader, now)
	if (parsed !== null) return parsed
	const exp = RETRY_BACKOFF_INITIAL_MS * 2 ** Math.max(0, attempt)
	return Math.min(RETRY_BACKOFF_CAP_MS, exp)
}

/** One answer's status and `Retry-After`, against the longest wait oat accepts. */
export interface RetryAfterInput {
	status: number
	header: string | undefined
	limitMs: number
}

/** The wait a 429 or a 503 asked for when it is longer than oat waits: that answer stands as it is. */
export function retryAfterVerdict(input: RetryAfterInput, now: number = Date.now()): RetryAfterExceeded | undefined {
	if (!WAITED_STATUSES.has(input.status)) return undefined
	const waitMs = parseRetryAfter(input.header, now)
	return waitMs === null || waitMs <= input.limitMs ? undefined : { limitMs: input.limitMs, waitMs }
}
