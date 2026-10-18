/** Live run status: one snapshot per event, handed to whoever prints or records it. */

export interface ProgressLast {
	method: string
	url: string
	status: number
	durationMs: number
	requestBytes: number
	responseBytes: number
	/** Empty when the last call had no request-id / correlation-id header. */
	requestId: string
	at: number
	/** Set when the last completed call never got an HTTP status. */
	network?: string
}

/** A request that has been dispatched and has not yet returned. */
export interface ProgressInflight {
	method: string
	url: string
	/** Wall clock when `fetch` was called, unix ms. */
	at: number
	requestId?: string
	requestBytes?: number
}

export interface ProgressSnapshot {
	phase: "load" | "auth" | "seed" | "test" | "scenario" | "contract" | "teardown" | "done"
	entity?: string
	entityIndex?: number
	entityTotal?: number
	check?: string
	requests: number
	findings: number
	last?: ProgressLast
	/** When set, formatters prefer this over `last` — the call is still on the wire. */
	inflight?: ProgressInflight
	message?: string
	elapsedMs: number
}

export type ProgressHandler = (snap: ProgressSnapshot) => void
