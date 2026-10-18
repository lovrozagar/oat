import type { NetworkClientOptions } from "../../client/types.ts"
import { type Fence, FencedError } from "../fence.ts"
import type { FindingCollector } from "../finding.ts"
import { createNetworkGate, type NetworkGate } from "../network/gate.ts"
import { DEFAULT_NETWORK_RETRIES, DEFAULT_NETWORK_WAIT_MS, resolveRequestTimeoutMs } from "../network/policy.ts"
import { describeNetworkFailure, type NetworkError } from "../../errors/network.ts"
import { probeOrigin } from "../network/probe.ts"
import type { RunProgress } from "./progress.ts"
import type { RunOptions, RunResult } from "./types.ts"
import type { RunFindingId } from "../check-ids.ts"

/** The run's view of the network: one gate every client waits on, and the outage, once noted. */
export interface RunNetwork {
	readonly gate: NetworkGate
	/** What every client of the run is given: the retries, the timeout and the gate. */
	readonly client: NetworkClientOptions
	/** The outage that cut the run short, when one did. */
	readonly outcome: RunResult["network"]
	/** Notes a request that never got an answer; the first outage is the run's. */
	note(error: NetworkError, where: string): Promise<void>
}

export interface NetworkInput {
	options: RunOptions
	fence: Fence | undefined
	progress: RunProgress
	findings: FindingCollector
}

/** `{ fetchImpl }` when the run was given its own transport, else nothing: the global fetch. */
export function transportOpt(options: RunOptions): { fetchImpl: typeof fetch } | Record<string, never> {
	const transport = options.network?.fetch
	return transport === undefined ? {} : { fetchImpl: transport }
}

/** `{ requestTimeoutMs }` when one is configured or defaulted, else nothing. */
export function requestTimeoutOpt(value: number | undefined): { requestTimeoutMs: number } | Record<string, never> {
	const timeoutMs = resolveRequestTimeoutMs(value)
	return timeoutMs === undefined ? {} : { requestTimeoutMs: timeoutMs }
}

export function createRunNetwork(input: NetworkInput): RunNetwork {
	const { options, progress, findings } = input
	const probe = (): Promise<boolean> => probeBase(input)
	const gate = createNetworkGate({
		onWait: (info) => {
			progress.tick({
				message: `waiting for network (${info.kind}, ${Math.ceil(info.remainingMs / 1000)}s left)`,
				phase: progress.phase,
				requests: progress.requests,
			})
		},
		probe,
		waitBudgetMs: options.network?.waitMs ?? DEFAULT_NETWORK_WAIT_MS,
	})
	let outcome: RunResult["network"]
	return {
		client: {
			awaitRecovery: (error) => gate.awaitRecovery(error),
			retries: options.network?.retries ?? DEFAULT_NETWORK_RETRIES,
			...requestTimeoutOpt(options.network?.requestTimeoutMs),
			...transportOpt(options),
		},
		gate,
		async note(error, where) {
			if (outcome !== undefined) return
			/* One operation that never answered, on a host that still answers, is that operation
			 * failing (reported with the server errors), not the network going away. */
			if (error.kind === "timeout" && (await probe())) return
			outcome = {
				attempts: error.attempts,
				incomplete: true,
				kind: error.kind,
				url: error.url,
				waitedMs: gate.waitedMs,
			}
			findings.gap(
				"net.unreachable" satisfies RunFindingId,
				where,
				`network down (${error.kind})`,
				describeNetworkFailure(error, gate.waitedMs),
			)
		},
		get outcome() {
			return outcome
		},
	}
}

/* Whether the host still answers — a request like any other, so the fence sees it first. */
async function probeBase({ options, fence }: NetworkInput): Promise<boolean> {
	try {
		await fence?.check({
			body: undefined,
			headers: {},
			method: "HEAD",
			phase: "probe",
			url: new URL(options.baseUrl).origin,
		})
	} catch (error) {
		if (error instanceof FencedError) return false
		throw error
	}
	return probeOrigin(options.baseUrl, transportOpt(options))
}
