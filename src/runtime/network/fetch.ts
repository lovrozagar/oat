/** `fetch` with the network policy applied, for the requests made outside the client: the spec load. */

import {
	classifyNetworkError,
	describeNetworkFailure,
	describeNetworkKind,
	isNetworkError,
	NetworkError,
} from "../../errors/network.ts"
import { sleep } from "../poll.ts"
import { createNetworkGate, type NetworkGateOptions, type NetworkWaitInfo } from "./gate.ts"
import { refineNetworkKind } from "./interfaces.ts"
import { DEFAULT_NETWORK_RETRIES, DEFAULT_NETWORK_WAIT_MS, networkRetryWaitMs } from "./policy.ts"
import { probeOrigin } from "./probe.ts"

export interface NetworkFetchOptions {
	retries?: number
	waitMs?: number
	requestTimeoutMs?: number
	probe?: () => Promise<boolean>
	sleep?: (ms: number) => Promise<void>
	onWait?: (info: NetworkWaitInfo) => void
	fetchImpl?: typeof fetch
	now?: () => number
}

interface FetchCall {
	url: string
	init: RequestInit
	method: string
	fetchImpl: typeof fetch
	options: NetworkFetchOptions
}

/** One attempt; a network failure comes back as a `NetworkError` naming its kind. */
async function attemptOnce(call: FetchCall, attempt: number): Promise<Response> {
	const { url, init, method, fetchImpl, options } = call
	try {
		const initWithTimeout: RequestInit =
			options.requestTimeoutMs === undefined ? init : { ...init, signal: AbortSignal.timeout(options.requestTimeoutMs) }
		return await fetchImpl(url, initWithTimeout)
	} catch (error) {
		const raw = classifyNetworkError(error)
		if (raw === null) throw error
		const kind = refineNetworkKind(raw)
		throw new NetworkError({
			attempts: attempt + 1,
			cause: error,
			kind,
			message: `${method} ${url} failed (${kind}: ${describeNetworkKind(kind)})`,
			method,
			url,
		})
	}
}

function gateOptions(call: FetchCall, pause: (ms: number) => Promise<void>): NetworkGateOptions {
	const { options, url, fetchImpl } = call
	return {
		probe: options.probe ?? (() => probeOrigin(url, { fetchImpl })),
		sleep: pause,
		waitBudgetMs: options.waitMs ?? DEFAULT_NETWORK_WAIT_MS,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.onWait === undefined ? {} : { onWait: options.onWait }),
	}
}

function exhaustedError(failed: NetworkError, waitedMs: number): NetworkError {
	return new NetworkError({
		attempts: failed.attempts,
		cause: failed,
		kind: failed.kind,
		message: describeNetworkFailure(failed, waitedMs),
		method: failed.method,
		url: failed.url,
	})
}

/**
 * `fetch` with the same classify / retry / wait policy Client uses, for spec load (no Exchange).
 */
export async function fetchWithNetworkRetry(
	url: string,
	init: RequestInit = {},
	options: NetworkFetchOptions = {},
): Promise<Response> {
	const retries = Math.max(0, options.retries ?? DEFAULT_NETWORK_RETRIES)
	const pause = options.sleep ?? sleep
	const fetchImpl = options.fetchImpl ?? fetch
	const method = (init.method ?? "GET").toUpperCase()
	const call: FetchCall = { fetchImpl, init, method, options, url }
	let last: NetworkError | undefined

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await attemptOnce(call, attempt)
		} catch (error) {
			if (!isNetworkError(error)) throw error
			last = error
			if (attempt < retries) await pause(networkRetryWaitMs(attempt))
		}
	}

	const gate = createNetworkGate(gateOptions(call, pause))
	/* The loop runs at least once and only falls through after a network failure. */
	const failed = last as NetworkError
	if (await gate.awaitRecovery(failed)) return attemptOnce(call, retries + 1)
	throw exhaustedError(failed, gate.waitedMs)
}

/** An OpenAPI document by URL, with the same retries a request gets. Throws on a non-2xx answer. */
export async function fetchSpecText(url: string, network?: NetworkFetchOptions): Promise<string> {
	const res = await fetchWithNetworkRetry(
		url,
		{ headers: { accept: "application/json" } },
		{ retries: DEFAULT_NETWORK_RETRIES, waitMs: 0, ...network },
	)
	if (!res.ok) throw new Error(`oat: fetching ${url} returned ${res.status} ${res.statusText}`)
	return res.text()
}
