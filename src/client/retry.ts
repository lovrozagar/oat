/** When a request is asked again: after a network failure, a 429, a 503 that names a wait, or a gateway's 5xx. */

import type { Exchange } from "../runtime/exchange.ts"
import { DEFAULT_NETWORK_RETRIES, networkRetryWaitMs } from "../runtime/network/policy.ts"
import { isNetworkError, type NetworkError, type NetworkKind } from "../errors/network.ts"
import { sleep } from "../runtime/poll.ts"
import {
	GATEWAY_RETRY_MS,
	MAX_429_RETRIES,
	MAX_UNAVAILABLE_RETRIES,
	parseRetryAfter,
	retryWaitMs,
} from "../runtime/rate-limit/retry-after.ts"
import { headerValue } from "../runtime/headers.ts"
import { BODILESS_READS, IDEMPOTENT } from "../spec/methods.ts"
import type { NetworkClientOptions } from "./types.ts"

/** How long one request may take across every attempt and wait, unless configured. */
export const DEFAULT_DEADLINE_MS: number = 10 * 60_000

/** Failures that prove the request never reached the server. */
const NEVER_SENT: ReadonlySet<NetworkKind> = /* @__PURE__ */ new Set(["offline", "dns", "refused", "unreachable"])
/* Statuses a gateway answers on its own; a read that met one is asked once more. */
const GATEWAY_STATUSES: ReadonlySet<number> = /* @__PURE__ */ new Set([502, 503, 504])

/** One request's network policy: how it may be resent, and until when. */
export interface Resending {
	method: string
	/** The caller's headers: an idempotency key among them makes a write repeatable. */
	headers: () => Record<string, string>
	network: NetworkClientOptions | undefined
	/** `performance.now()` past which nothing is resent. */
	deadline: number
}

/*
 * A failed request may be sent again only when doing so cannot do something twice: it never left
 * this machine, or the method is idempotent, or it carries an idempotency key. A POST that timed
 * out may well have created its record — resending it creates a second one, and oat would then
 * report the duplicate as the backend's.
 */
function repeatable(error: NetworkError, policy: Resending): boolean {
	return (
		NEVER_SENT.has(error.kind) ||
		IDEMPOTENT.has(policy.method) ||
		Object.keys(policy.headers()).some((name) => /idempotency[-_]?key/i.test(name))
	)
}

/** `dispatch`, resent after a network failure while the policy allows, then once more if the link recovers. */
export async function resilient(
	dispatch: (attempt: number) => Promise<Exchange>,
	policy: Resending,
): Promise<Exchange> {
	const { network } = policy
	const retries = network === undefined ? 0 : Math.max(0, network.retries ?? DEFAULT_NETWORK_RETRIES)
	let last: NetworkError | undefined
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await dispatch(attempt)
		} catch (error) {
			if (!isNetworkError(error) || !repeatable(error, policy)) throw error
			last = error
			const wait = networkRetryWaitMs(attempt)
			if (performance.now() + wait > policy.deadline) throw error
			if (attempt < retries) await sleep(wait)
		}
	}
	/* The last attempt reached here only with time left past its wait: the deadline still holds. */
	const failed = last as NetworkError
	if ((await network?.awaitRecovery?.(failed)) === true) return dispatch(retries + 1)
	throw failed
}

/** How a status retry asks again. */
export interface StatusRetry {
	method: string
	/** Supersedes `previous` and sends the request again. */
	again: (previous: Exchange) => Promise<Exchange>
	/** `exchange`, or the answer after a refresh when it is a 401. */
	reauthorized: (exchange: Exchange) => Promise<Exchange>
	/** Tells the rate limiter the server asked for `waitMs`. */
	backedOff: (waitMs: number) => void
}

/** The backend's final answer, after the waits it asked for and one more try past a gateway's 5xx. */
export async function untilAnswered(first: Exchange, retry: StatusRetry): Promise<Exchange> {
	return afterGateway(await afterWaits(first, retry), retry)
}

/*
 * The waits the backend asks for, in whatever order it asks: a backend may shed load with a 503 and
 * then rate-limit the retry with a 429, and each answer is followed as it comes. Each status keeps its
 * own retries across the alternation, so the two together still end; a wait past the limit stands.
 *
 * 429 is reactive: the first one is never a seed/check failure. Tags pace proactively; this path
 * honors the server even when the op has no x-rate-limit at all, and a wait past the limit never
 * reaches the limiter, where it would hold back every request that shares the route's bucket.
 * A 503 that names when to come back is a cue a well-behaved client follows; one that names no wait
 * stands as the verdict.
 */
async function afterWaits(first: Exchange, retry: StatusRetry): Promise<Exchange> {
	let exchange = first
	let limited = 0
	let unavailable = 0
	while (exchange.retryAfterExceeded === undefined) {
		const header = headerValue(exchange.responseHeaders, "retry-after")
		if (exchange.status === 429 && limited < MAX_429_RETRIES) {
			const waitMs = retryWaitMs(header, limited++)
			retry.backedOff(waitMs)
			if (waitMs > 0) await sleep(waitMs)
			exchange = await retry.reauthorized(await retry.again(exchange))
			continue
		}
		const waitMs = exchange.status === 503 ? parseRetryAfter(header) : null
		if (waitMs === null || unavailable >= MAX_UNAVAILABLE_RETRIES) break
		unavailable++
		await sleep(waitMs)
		exchange = await retry.again(exchange)
	}
	return exchange
}

/* A gateway in front of the API answers 502, 503 or 504 now and then without the request reaching
 * it. A read with no body is safe to ask again: once, after a pause. A status that persists stands,
 * and a write is never repeated, and so does a 503 whose named wait is past the limit. */
async function afterGateway(exchange: Exchange, retry: StatusRetry): Promise<Exchange> {
	if (!GATEWAY_STATUSES.has(exchange.status) || !BODILESS_READS.has(retry.method)) return exchange
	if (exchange.retryAfterExceeded !== undefined) return exchange
	await sleep(GATEWAY_RETRY_MS)
	return retry.again(exchange)
}
