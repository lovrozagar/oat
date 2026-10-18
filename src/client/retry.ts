/** When a request is asked again: after a network failure, a 429, a 503 that names a wait, or a gateway's 5xx. */

import type { Exchange } from "../runtime/exchange.ts"
import {
	DEFAULT_NETWORK_RETRIES,
	isNetworkError,
	type NetworkError,
	type NetworkKind,
	networkRetryWaitMs,
} from "../runtime/network.ts"
import { sleep } from "../runtime/poll.ts"
import {
	GATEWAY_RETRY_MS,
	headerValue,
	MAX_429_RETRIES,
	MAX_UNAVAILABLE_RETRIES,
	parseRetryAfter,
	retryWaitMs,
	UNAVAILABLE_WAIT_BUDGET_MS,
} from "../runtime/rate-limit.ts"
import type { NetworkClientOptions } from "./types.ts"

/** How long one request may take across every attempt and wait, unless configured. */
export const DEFAULT_DEADLINE_MS = 10 * 60_000

/** Failures that prove the request never reached the server. */
const NEVER_SENT: ReadonlySet<NetworkKind> = /* @__PURE__ */ new Set(["offline", "dns", "refused", "unreachable"])
const IDEMPOTENT: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
/* Statuses a gateway answers on its own; a read that met one is asked once more. */
const GATEWAY_STATUSES: ReadonlySet<number> = /* @__PURE__ */ new Set([502, 503, 504])
const READ_METHODS: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD"])

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
	const limited = await afterTooMany(first, retry)
	const available = await afterUnavailable(limited, retry)
	return afterGateway(available, retry)
}

/* 429 is reactive: the first one is never a seed/check failure. Tags pace proactively; this path
 * honours the server even when the op has no x-rate-limit at all. */
async function afterTooMany(first: Exchange, retry: StatusRetry): Promise<Exchange> {
	let exchange = first
	for (let attempt = 0; exchange.status === 429 && attempt < MAX_429_RETRIES; attempt++) {
		const waitMs = retryWaitMs(headerValue(exchange.responseHeaders, "retry-after"), attempt)
		retry.backedOff(waitMs)
		if (waitMs > 0) await sleep(waitMs)
		exchange = await retry.reauthorized(await retry.again(exchange))
	}
	return exchange
}

/* A 503 that names when to come back is a cue a well-behaved client follows: wait, ask again. One
 * that names no wait, or outlasts the budget, stands as the verdict. */
async function afterUnavailable(first: Exchange, retry: StatusRetry): Promise<Exchange> {
	let exchange = first
	let waited = 0
	for (let attempt = 0; exchange.status === 503 && attempt < MAX_UNAVAILABLE_RETRIES; attempt++) {
		const waitMs = parseRetryAfter(headerValue(exchange.responseHeaders, "retry-after"))
		if (waitMs === null || waited + waitMs > UNAVAILABLE_WAIT_BUDGET_MS) break
		await sleep(waitMs)
		waited += waitMs
		exchange = await retry.again(exchange)
	}
	return exchange
}

/* A gateway in front of the API answers 502, 503 or 504 now and then without the request reaching
 * it. A read is safe to ask again: once, after a pause. A status that persists stands, and a write
 * is never repeated. */
async function afterGateway(exchange: Exchange, retry: StatusRetry): Promise<Exchange> {
	if (!GATEWAY_STATUSES.has(exchange.status) || !READ_METHODS.has(retry.method)) return exchange
	await sleep(GATEWAY_RETRY_MS)
	return retry.again(exchange)
}
