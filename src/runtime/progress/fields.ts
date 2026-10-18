/** One progress snapshot as the column values every format prints. */

import type { ProgressInflight, ProgressLast, ProgressSnapshot } from "./types.ts"

/** Idle this long after a completed call reads as a stall. */
export const STALL_MS = 15_000

export interface ProgressFields {
	status: string
	done: string
	total: string
	phase: string
	entity: string
	check: string
	msg: string
	req: string
	find: string
	method: string
	path: string
	http: string
	req_id: string
	last_at: string
	last_ms: string
	req_b: string
	res_b: string
	idle_ms: string
	elapsed_ms: string
}

type CallFields = Pick<
	ProgressFields,
	"http" | "idle_ms" | "last_at" | "last_ms" | "method" | "path" | "req_b" | "req_id" | "res_b" | "status"
>

/** Path + query, never truncated. Origin is already in the report backend field. */
function requestPath(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.pathname}${parsed.search}`
	} catch {
		return url
	}
}

/** The columns that describe the run, whatever the last call was. */
function runFields(snap: ProgressSnapshot): Omit<ProgressFields, keyof CallFields> {
	return {
		check: snap.check ?? "-",
		done: snap.entityIndex === undefined ? "-" : String(snap.entityIndex),
		elapsed_ms: String(Math.max(0, Math.round(snap.elapsedMs))),
		entity: snap.entity ?? "-",
		find: String(snap.findings),
		msg: snap.message ?? "-",
		phase: snap.phase,
		req: String(snap.requests),
		total: snap.entityTotal === undefined ? "-" : String(snap.entityTotal),
	}
}

/** A call still on the wire: idle counts from when it started, and it has no answer yet. */
function inflightFields(inflight: ProgressInflight, now: number): CallFields {
	const requestId = inflight.requestId
	return {
		http: "-",
		idle_ms: String(Math.max(0, now - inflight.at)),
		last_at: new Date(inflight.at).toISOString(),
		last_ms: "-",
		method: inflight.method,
		path: requestPath(inflight.url),
		req_b: inflight.requestBytes === undefined ? "-" : String(inflight.requestBytes),
		req_id: requestId === undefined || requestId === "" ? "-" : requestId,
		res_b: "-",
		status: "in_flight",
	}
}

const NO_CALL: CallFields = {
	http: "-",
	idle_ms: "-",
	last_at: "-",
	last_ms: "-",
	method: "-",
	path: "-",
	req_b: "-",
	req_id: "-",
	res_b: "-",
	status: "ok",
}

/** The last completed call, or dashes before the first one. */
function lastFields(last: ProgressLast | undefined, now: number): CallFields {
	if (last === undefined) return NO_CALL
	const stalled = now - last.at >= STALL_MS
	return {
		http: String(last.status),
		idle_ms: String(Math.max(0, now - last.at)),
		last_at: new Date(last.at).toISOString(),
		last_ms: String(last.durationMs),
		method: last.method,
		path: requestPath(last.url),
		req_b: String(last.requestBytes),
		req_id: last.requestId,
		res_b: String(last.responseBytes),
		status: last.network !== undefined ? "network" : stalled ? "stall" : "ok",
	}
}

export function progressFields(snap: ProgressSnapshot, now: number): ProgressFields {
	const call = snap.inflight === undefined ? lastFields(snap.last, now) : inflightFields(snap.inflight, now)
	return { ...runFields(snap), ...call }
}
