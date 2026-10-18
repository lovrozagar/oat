/** The one wait for the link a run makes once its retries are spent, shared by every request. */

import type { NetworkError, NetworkKind } from "../../errors/network.ts"
import { sleep } from "../poll.ts"
import { DEFAULT_NETWORK_PROBE_MS, DEFAULT_NETWORK_WAIT_MS } from "./policy.ts"

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

export interface NetworkGateOptions {
	waitBudgetMs?: number
	probeIntervalMs?: number
	probe: () => Promise<boolean>
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	onWait?: (info: NetworkWaitInfo) => void
}

interface GateState {
	exhausted: boolean
	waitedMs: number
	lastKind: NetworkKind | undefined
}

interface GateTiming {
	options: NetworkGateOptions
	waitBudgetMs: number
	probeIntervalMs: number
	pause: (ms: number) => Promise<void>
	now: () => number
}

/** Probes until the link answers or the budget runs out; `false` exhausts the gate for good. */
async function waitOnce(state: GateState, timing: GateTiming, error: NetworkError): Promise<boolean> {
	const { options, waitBudgetMs, probeIntervalMs, pause, now } = timing
	state.lastKind = error.kind
	if (waitBudgetMs === 0) {
		state.exhausted = true
		return false
	}
	const began = now()
	const deadline = began + waitBudgetMs
	options.onWait?.({ elapsedMs: 0, kind: error.kind, remainingMs: waitBudgetMs })
	while (now() < deadline) {
		const remaining = deadline - now()
		await pause(Math.min(probeIntervalMs, Math.max(0, remaining)))
		state.waitedMs = now() - began
		options.onWait?.({
			elapsedMs: state.waitedMs,
			kind: error.kind,
			remainingMs: Math.max(0, deadline - now()),
		})
		if (await options.probe()) return true
	}
	state.waitedMs = Math.max(state.waitedMs, now() - began)
	state.exhausted = true
	return false
}

export function createNetworkGate(options: NetworkGateOptions): NetworkGate {
	const timing: GateTiming = {
		now: options.now ?? Date.now,
		options,
		pause: options.sleep ?? sleep,
		probeIntervalMs: Math.max(50, options.probeIntervalMs ?? DEFAULT_NETWORK_PROBE_MS),
		waitBudgetMs: Math.max(0, options.waitBudgetMs ?? DEFAULT_NETWORK_WAIT_MS),
	}
	const state: GateState = { exhausted: false, lastKind: undefined, waitedMs: 0 }
	let inflight: Promise<boolean> | undefined

	return {
		get exhausted() {
			return state.exhausted
		},
		get lastKind() {
			return state.lastKind
		},
		get waitedMs() {
			return state.waitedMs
		},
		awaitRecovery(error) {
			if (state.exhausted) return Promise.resolve(false)
			if (inflight !== undefined) return inflight
			inflight = waitOnce(state, timing, error).finally(() => {
				inflight = undefined
			})
			return inflight
		},
	}
}
