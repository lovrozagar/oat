/**
 * Live run status.
 *
 * Logs are logfmt (key=value, one event per line) — the usual shape for
 * machines and people. Values are never truncated: a fixed-width table
 * forced "…" on check names and URLs, and wrapped the header in a normal
 * editor so the columns stopped lining up.
 *
 * stderr and progress.log are the same format. progress.jsonl is the same
 * events as JSON. progress.tsv is the same columns, tab-separated.
 */

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
}

export interface ProgressSnapshot {
	phase: "load" | "auth" | "seed" | "test" | "teardown" | "done"
	entity?: string
	entityIndex?: number
	entityTotal?: number
	check?: string
	requests: number
	findings: number
	last?: ProgressLast
	message?: string
	elapsedMs: number
}

export type ProgressHandler = (snap: ProgressSnapshot) => void

const HEARTBEAT_MS = 5_000
const STALL_MS = 15_000

export const PROGRESS_TSV_HEADER = [
	"ts_ms",
	"status",
	"done",
	"total",
	"phase",
	"entity",
	"check",
	"msg",
	"req",
	"find",
	"method",
	"path",
	"http",
	"req_id",
	"last_at",
	"last_ms",
	"req_b",
	"res_b",
	"idle_ms",
	"elapsed_ms",
].join("\t")

export const PROGRESS_GLOSSARY = [
	"# logfmt — one event per line, full values, no truncation",
	"# ts               when this line was written (ISO-8601 UTC). ts_ms is the same instant as unix ms",
	"# status=ok|stall  stall means idle_ms >= 15000 (last call finished, nothing since)",
	"# done/total       entity index / how many entities",
	"# phase            load|auth|seed|test|teardown|done",
	"# check            check id (empty when not in a check)",
	"# msg              phase note (seeding, spec URL, teardown count)",
	"# req_id           x-request-id / request-id / x-correlation-id / correlation-id on that call (empty if none)",
	"# last_at          wall clock of that call (ISO-8601 UTC)",
	"# last_ms          duration of the last HTTP call",
	"# req_b / res_b    reconstructed HTTP/1.1 size (start line + headers + body) of that call",
	"# idle_ms          ms since that call returned — if this climbs, the run is stuck",
	"# elapsed_ms       wall clock since oat started",
].join("\n")

export function formatProgressLine(snap: ProgressSnapshot, now = Date.now()): string {
	const f = fields(snap, now)
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

export function formatProgressTsv(snap: ProgressSnapshot, now = Date.now()): string {
	const f = fields(snap, now)
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

export function formatProgressJsonl(snap: ProgressSnapshot, now = Date.now()): string {
	const f = fields(snap, now)
	return JSON.stringify({
		check: f.check === "-" ? null : f.check,
		done: snap.entityIndex ?? null,
		elapsed_ms: Number(f.elapsed_ms),
		entity: snap.entity ?? null,
		find: snap.findings,
		http: snap.last?.status ?? null,
		idle_ms: f.idle_ms === "-" ? null : Number(f.idle_ms),
		last_at: f.last_at === "-" ? null : f.last_at,
		last_ms: f.last_ms === "-" ? null : Number(f.last_ms),
		method: f.method === "-" ? null : f.method,
		req_id: f.req_id === "" || f.req_id === "-" ? null : f.req_id,
		req_b: f.req_b === "-" ? null : Number(f.req_b),
		res_b: f.res_b === "-" ? null : Number(f.res_b),
		msg: f.msg === "-" ? null : f.msg,
		path: f.path === "-" ? null : f.path,
		phase: snap.phase,
		req: snap.requests,
		status: f.status,
		total: snap.entityTotal ?? null,
		ts: new Date(now).toISOString(),
		ts_ms: now,
	})
}

export function createStderrProgress(startedAt = Date.now()): {
	emit: ProgressHandler
	stop: () => void
} {
	let latest: ProgressSnapshot | undefined
	let lastKey = ""
	let lastWrite = 0
	let headed = false

	const write = (snap: ProgressSnapshot): void => {
		if (!headed) {
			headed = true
			process.stderr.write(`${PROGRESS_GLOSSARY}\n`)
		}
		process.stderr.write(`${formatProgressLine(snap)}\n`)
		lastWrite = Date.now()
	}

	const timer = setInterval(() => {
		if (latest === undefined) return
		write({ ...latest, elapsedMs: Date.now() - startedAt })
	}, HEARTBEAT_MS)
	timer.unref()

	return {
		emit(snap) {
			latest = snap
			const key = `${snap.phase}|${snap.entity ?? ""}|${snap.check ?? ""}|${snap.message ?? ""}`
			const keyChanged = key !== lastKey
			lastKey = key
			const stalled = snap.last !== undefined && Date.now() - snap.last.at >= STALL_MS
			const force =
				snap.phase === "done" ||
				snap.phase === "load" ||
				snap.phase === "auth" ||
				(snap.phase === "seed" && snap.check === undefined)
			const due = Date.now() - lastWrite >= 2_000
			if (force || keyChanged || stalled || due) write(snap)
		},
		stop() {
			clearInterval(timer)
		},
	}
}

function fields(
	snap: ProgressSnapshot,
	now: number,
): {
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
} {
	const stalled = snap.last !== undefined && now - snap.last.at >= STALL_MS
	return {
		check: snap.check ?? "-",
		done: snap.entityIndex === undefined ? "-" : String(snap.entityIndex),
		elapsed_ms: String(Math.max(0, Math.round(snap.elapsedMs))),
		entity: snap.entity ?? "-",
		find: String(snap.findings),
		http: snap.last === undefined ? "-" : String(snap.last.status),
		idle_ms: snap.last === undefined ? "-" : String(Math.max(0, now - snap.last.at)),
		last_at: snap.last === undefined ? "-" : new Date(snap.last.at).toISOString(),
		last_ms: snap.last === undefined ? "-" : String(snap.last.durationMs),
		method: snap.last === undefined ? "-" : snap.last.method,
		req_id: snap.last === undefined ? "-" : snap.last.requestId,
		req_b: snap.last === undefined ? "-" : String(snap.last.requestBytes),
		res_b: snap.last === undefined ? "-" : String(snap.last.responseBytes),
		msg: snap.message ?? "-",
		path: snap.last === undefined ? "-" : requestPath(snap.last.url),
		phase: snap.phase,
		req: String(snap.requests),
		status: stalled ? "stall" : "ok",
		total: snap.entityTotal === undefined ? "-" : String(snap.entityTotal),
	}
}

function logfmt(pairs: Record<string, string>): string {
	return Object.entries(pairs)
		.map(([key, value]) => {
			if (value !== "" && !/[\s="\\]/.test(value)) return `${key}=${value}`
			return `${key}=${JSON.stringify(value)}`
		})
		.join(" ")
}

/** Path + query, never truncated. Origin is already in the report backend field. */
function requestPath(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.pathname}${parsed.search}`
	} catch {
		return url
	}
}
