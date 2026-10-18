import type { HttpHooks, RequestStart } from "../../client/types.ts"
import type { Exchange } from "../exchange.ts"
import type { ProgressHandler, ProgressInflight, ProgressLast, ProgressSnapshot } from "../progress/types.ts"

type Phase = ProgressSnapshot["phase"]

/** What a tick moves the run to. Each field left out keeps what the run was already on. */
export interface Tick {
	phase: Phase
	entity?: string | undefined
	entityIndex?: number | undefined
	entityTotal?: number | undefined
	check?: string | undefined
	message?: string | undefined
	requests?: number | undefined
}

interface SnapshotExtra {
	message?: string
	requests?: number
	inflight?: ProgressInflight
	omitInflight?: boolean
}

/**
 * Where the run is, for the live status: the phase, entity and check it is on, the last answer,
 * and the requests still in flight. Every stage moves it; `onProgress` sees each move.
 */
export class RunProgress {
	phase: Phase = "load"
	entity: string | undefined
	check: string | undefined
	entityIndex: number | undefined
	entityTotal: number | undefined
	private last: ProgressLast | undefined
	private readonly inflight = new Set<RequestStart>()
	private requestCount: () => number = () => 0

	constructor(
		private readonly handler: ProgressHandler | undefined,
		private readonly startedAt: number,
		private readonly defects: () => number,
	) {}

	/** Counts requests from the client, once there is one. */
	countRequests(count: () => number): void {
		this.requestCount = count
	}

	get requests(): number {
		return this.requestCount()
	}

	tick(partial: Tick): void {
		this.phase = partial.phase
		if (partial.entity !== undefined) this.entity = partial.entity
		if (partial.entityIndex !== undefined) this.entityIndex = partial.entityIndex
		if (partial.entityTotal !== undefined) this.entityTotal = partial.entityTotal
		if (partial.check !== undefined) this.check = partial.check
		this.publish({
			...(partial.message === undefined ? {} : { message: partial.message }),
			...(partial.requests === undefined ? {} : { requests: partial.requests }),
		})
	}

	/** A stage after the checks names itself, so `teardown` means records are being removed. */
	enter(phase: Phase, message: string): void {
		this.check = undefined
		this.tick({ message, phase, requests: this.requests })
	}

	/** An answer arrived: it is the last one. */
	remember(exchange: Exchange): void {
		this.last = lastOf(exchange)
	}

	/** The last answer is shown, then the oldest request still out. */
	announce(): void {
		this.publish({ omitInflight: true })
		const remaining = this.oldestInflight()
		if (remaining !== undefined) this.publish({ inflight: remaining })
	}

	/** Tracks each request from dispatch to answer. */
	readonly httpHooks: HttpHooks = {
		end: (probe) => {
			this.inflight.delete(probe)
		},
		start: (probe) => {
			this.inflight.add(probe)
			this.publish({ inflight: displayed(probe) })
		},
	}

	private publish(extra: SnapshotExtra): void {
		this.handler?.(this.snapshot(extra))
	}

	private snapshot(extra: SnapshotExtra): ProgressSnapshot {
		const snap: ProgressSnapshot = {
			elapsedMs: Date.now() - this.startedAt,
			findings: this.defects(),
			phase: this.phase,
			requests: extra.requests ?? this.requests,
		}
		if (this.check !== undefined) snap.check = this.check
		if (this.entity !== undefined) snap.entity = this.entity
		if (this.entityIndex !== undefined) snap.entityIndex = this.entityIndex
		if (this.entityTotal !== undefined) snap.entityTotal = this.entityTotal
		if (extra.message !== undefined) snap.message = extra.message
		if (this.last !== undefined) snap.last = this.last
		if (extra.omitInflight !== true) {
			const live = extra.inflight ?? this.oldestInflight()
			if (live !== undefined) snap.inflight = live
		}
		return snap
	}

	private oldestInflight(): ProgressInflight | undefined {
		let oldest: RequestStart | undefined
		for (const probe of this.inflight) {
			if (oldest === undefined || probe.at < oldest.at) oldest = probe
		}
		return oldest === undefined ? undefined : displayed(oldest)
	}
}

function displayed(probe: RequestStart): ProgressInflight {
	const shown: ProgressInflight = { at: probe.at, method: probe.method, url: probe.url }
	if (probe.requestId !== "") shown.requestId = probe.requestId
	shown.requestBytes = probe.requestBytes
	return shown
}

function lastOf(exchange: Exchange): ProgressLast {
	return {
		at: exchange.at,
		durationMs: exchange.durationMs,
		method: exchange.method,
		requestBytes: exchange.requestBytes,
		requestId: exchange.requestId,
		responseBytes: exchange.responseBytes,
		status: exchange.status,
		url: exchange.url,
		...(exchange.network === undefined ? {} : { network: exchange.network.kind }),
	}
}
