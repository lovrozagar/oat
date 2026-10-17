/**
 * Network failures are not backend defects.
 *
 * `fetch` throwing is "the request never happened" — DNS, offline, reset, timeout — and must
 * not look like a 4xx/5xx or an uncaught `TypeError: fetch failed`. Classify, retry the blip,
 * then wait once for the link. If it does not come back, one finding names the kind and the
 * rest of the run stands down.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"
import {
	classifyNetworkError,
	describeNetworkFailure,
	describeNetworkKind,
	isNetworkError,
	NetworkError,
	type NetworkKind,
} from "../errors/network.ts"
import { sleep } from "./poll.ts"

export {
	classifyNetworkError,
	describeNetworkFailure,
	describeNetworkKind,
	isNetworkError,
	NetworkError,
	type NetworkKind,
} from "../errors/network.ts"

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

export function refineNetworkKind(
	kind: NetworkKind,
	read: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces,
): NetworkKind {
	if (kind === "offline") return kind
	return hasUsableInterface(read) ? kind : "offline"
}

export function hasUsableInterface(read: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces): boolean {
	for (const list of Object.values(read())) {
		for (const info of list ?? []) {
			if (!info.internal && info.address !== "") return true
		}
	}
	return false
}

export function networkRetryWaitMs(attempt: number): number {
	return Math.min(4_000, 250 * 2 ** Math.max(0, attempt))
}

export interface NetworkWaitInfo {
	kind: NetworkKind
	elapsedMs: number
	remainingMs: number
}

export interface NetworkGate {
	readonly exhausted: boolean
	readonly waitedMs: number
	readonly lastKind: NetworkKind | undefined
	awaitRecovery(error: NetworkError): Promise<boolean>
}

export function createNetworkGate(options: {
	waitBudgetMs?: number
	probeIntervalMs?: number
	probe: () => Promise<boolean>
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	onWait?: (info: NetworkWaitInfo) => void
}): NetworkGate {
	const waitBudgetMs = Math.max(0, options.waitBudgetMs ?? DEFAULT_NETWORK_WAIT_MS)
	const probeIntervalMs = Math.max(50, options.probeIntervalMs ?? DEFAULT_NETWORK_PROBE_MS)
	const pause = options.sleep ?? sleep
	const now = options.now ?? Date.now
	let exhausted = false
	let waitedMs = 0
	let lastKind: NetworkKind | undefined
	let inflight: Promise<boolean> | undefined

	const waitOnce = async (error: NetworkError): Promise<boolean> => {
		lastKind = error.kind
		if (waitBudgetMs === 0) {
			exhausted = true
			return false
		}
		const began = now()
		const deadline = began + waitBudgetMs
		options.onWait?.({ elapsedMs: 0, kind: error.kind, remainingMs: waitBudgetMs })
		while (now() < deadline) {
			const remaining = deadline - now()
			await pause(Math.min(probeIntervalMs, Math.max(0, remaining)))
			waitedMs = now() - began
			options.onWait?.({
				elapsedMs: waitedMs,
				kind: error.kind,
				remainingMs: Math.max(0, deadline - now()),
			})
			if (await options.probe()) return true
		}
		waitedMs = Math.max(waitedMs, now() - began)
		exhausted = true
		return false
	}

	return {
		get exhausted() {
			return exhausted
		},
		get lastKind() {
			return lastKind
		},
		get waitedMs() {
			return waitedMs
		},
		awaitRecovery(error) {
			if (exhausted) return Promise.resolve(false)
			if (inflight !== undefined) return inflight
			inflight = waitOnce(error).finally(() => {
				inflight = undefined
			})
			return inflight
		},
	}
}

export async function probeOrigin(
	origin: string,
	options: { timeoutMs?: number; fetchImpl?: typeof fetch; online?: () => boolean } = {},
): Promise<boolean> {
	const online = options.online ?? hasUsableInterface
	if (!online()) return false
	const timeoutMs = options.timeoutMs ?? 2_000
	const fetchImpl = options.fetchImpl ?? fetch
	let url: URL
	try {
		url = new URL(origin)
	} catch {
		return false
	}
	try {
		const response = await fetchImpl(url.origin, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		})
		return response.status > 0
	} catch (error) {
		return classifyNetworkError(error) === null
	}
}

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
	let last: NetworkError | undefined

	const once = async (attempt: number): Promise<Response> => {
		try {
			const initWithTimeout: RequestInit =
				options.requestTimeoutMs === undefined
					? init
					: { ...init, signal: AbortSignal.timeout(options.requestTimeoutMs) }
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

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await once(attempt)
		} catch (error) {
			if (!isNetworkError(error)) throw error
			last = error
			if (attempt < retries) await pause(networkRetryWaitMs(attempt))
		}
	}

	const gate = createNetworkGate({
		probe: options.probe ?? (() => probeOrigin(url, { fetchImpl })),
		sleep: pause,
		waitBudgetMs: options.waitMs ?? DEFAULT_NETWORK_WAIT_MS,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.onWait === undefined ? {} : { onWait: options.onWait }),
	})
	const failed = last as NetworkError
	if (await gate.awaitRecovery(failed)) return once(retries + 1)
	throw new NetworkError({
		attempts: failed.attempts,
		cause: failed,
		kind: failed.kind,
		message: describeNetworkFailure(failed, gate.waitedMs),
		method: failed.method,
		url: failed.url,
	})
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
