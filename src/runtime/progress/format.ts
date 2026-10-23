/** A progress snapshot as one logfmt line, one TSV row, or one JSON line. */

import { progressFields } from "./fields.ts"
import type { ProgressSnapshot } from "./types.ts"

function logfmt(pairs: Record<string, string>): string {
	return Object.entries(pairs)
		.map(([key, value]) => {
			if (value !== "" && !/[\s="\\]/.test(value)) return `${key}=${value}`
			return `${key}=${JSON.stringify(value)}`
		})
		.join(" ")
}

/** A column's dash, the "no value" of the text formats, as JSON's `null`. */
function textOrNull(value: string): string | null {
	return value === "-" ? null : value
}

function numberOrNull(value: string): number | null {
	return value === "-" ? null : Number(value)
}

export function formatProgressLine(snap: ProgressSnapshot, now: number = Date.now()): string {
	const f = progressFields(snap, now)
	return logfmt({
		ts: new Date(now).toISOString(),
		status: f.status,
		done: f.done,
		total: f.total,
		phase: f.phase,
		entity: f.entity,
		check: f.check,
		msg: f.msg,
		req: f.req,
		find: f.find,
		method: f.method,
		path: f.path,
		http: f.http,
		req_id: f.req_id,
		last_at: f.last_at,
		last_ms: f.last_ms,
		req_b: f.req_b,
		res_b: f.res_b,
		idle_ms: f.idle_ms,
		elapsed_ms: f.elapsed_ms,
	})
}

export function formatProgressTsv(snap: ProgressSnapshot, now: number = Date.now()): string {
	const f = progressFields(snap, now)
	return [
		now,
		f.status,
		f.done,
		f.total,
		f.phase,
		f.entity,
		f.check,
		f.msg,
		f.req,
		f.find,
		f.method,
		f.path,
		f.http,
		f.req_id,
		f.last_at,
		f.last_ms,
		f.req_b,
		f.res_b,
		f.idle_ms,
		f.elapsed_ms,
	].join("\t")
}

export function formatProgressJsonl(snap: ProgressSnapshot, now: number = Date.now()): string {
	const f = progressFields(snap, now)
	const inflight = snap.inflight !== undefined
	return JSON.stringify({
		check: textOrNull(f.check),
		done: snap.entityIndex ?? null,
		elapsed_ms: Number(f.elapsed_ms),
		entity: snap.entity ?? null,
		find: snap.findings,
		http: inflight ? null : (snap.last?.status ?? null),
		idle_ms: numberOrNull(f.idle_ms),
		last_at: textOrNull(f.last_at),
		last_ms: numberOrNull(f.last_ms),
		method: textOrNull(f.method),
		req_id: f.req_id === "" ? null : textOrNull(f.req_id),
		req_b: numberOrNull(f.req_b),
		res_b: numberOrNull(f.res_b),
		msg: textOrNull(f.msg),
		path: textOrNull(f.path),
		phase: snap.phase,
		req: snap.requests,
		status: f.status,
		total: snap.entityTotal ?? null,
		ts: new Date(now).toISOString(),
		ts_ms: now,
	})
}
