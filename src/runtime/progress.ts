/**
 * Live run status. oat used to print nothing until the last check; a 30-minute
 * HTTPS run then looks identical to a hang.
 *
 * stderr: one updating line on a TTY, a new line every entity / heartbeat otherwise
 * (so `tee` actually grows). `progress.log` / `progress.json` live in --out.
 */

export interface ProgressLast {
	method: string
	url: string
	status: number
	durationMs: number
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

export function formatProgressLine(snap: ProgressSnapshot, now = Date.now()): string {
	const elapsed = formatDuration(snap.elapsedMs)
	const frac =
		snap.entityIndex !== undefined && snap.entityTotal !== undefined && snap.entityTotal > 0
			? `${snap.entityIndex}/${snap.entityTotal}`
			: "-"
	const age = snap.last === undefined ? "-" : `${Math.max(0, Math.round((now - snap.last.at) / 1000))}s`
	const stalled = snap.last !== undefined && now - snap.last.at >= STALL_MS
	const last =
		snap.last === undefined
			? ""
			: `  ${snap.last.method} ${shortUrl(snap.last.url)} ${snap.last.status} ${snap.last.durationMs}ms ${age} ago`
	const check = snap.check ?? snap.message ?? ""
	const bar = renderBar(snap.entityIndex, snap.entityTotal)
	const head = stalled ? "oat STALL" : "oat"
	return (
		`${head}  ${bar} ${frac}  ${snap.phase}` +
		`${snap.entity !== undefined ? `  ${snap.entity}` : ""}` +
		`${check !== "" ? `  ${check}` : ""}` +
		`  req ${snap.requests}  find ${snap.findings}${last}  ${elapsed}`
	)
}

export function createStderrProgress(startedAt = Date.now()): {
	emit: ProgressHandler
	stop: () => void
} {
	let latest: ProgressSnapshot | undefined
	let lastKey = ""
	const tty = process.stderr.isTTY === true
	let lastWrite = 0

	const write = (snap: ProgressSnapshot, newline: boolean): void => {
		const line = formatProgressLine(snap)
		if (tty && !newline && snap.phase !== "done") {
			process.stderr.write(`\r${line}\x1b[K`)
		} else {
			if (tty && lastWrite > 0) process.stderr.write("\n")
			process.stderr.write(`${line}\n`)
		}
		lastWrite = Date.now()
	}

	const timer = setInterval(() => {
		if (latest === undefined) return
		write({ ...latest, elapsedMs: Date.now() - startedAt }, !tty)
	}, HEARTBEAT_MS)
	timer.unref()

	return {
		emit(snap) {
			latest = snap
			const key = `${snap.phase}|${snap.entity ?? ""}|${snap.check ?? snap.message ?? ""}`
			const keyChanged = key !== lastKey
			lastKey = key
			const stalled = snap.last !== undefined && Date.now() - snap.last.at >= STALL_MS
			const force =
				snap.phase === "done"
				|| snap.phase === "load"
				|| snap.phase === "auth"
				|| (snap.phase === "seed" && snap.check === undefined)
			const due = Date.now() - lastWrite >= 2_000
			if (force || keyChanged || stalled || due) write(snap, force || keyChanged || !tty)
		},
		stop() {
			clearInterval(timer)
			if (tty && lastWrite > 0) process.stderr.write("\n")
		},
	}
}

function renderBar(index: number | undefined, total: number | undefined): string {
	if (index === undefined || total === undefined || total <= 0) return "[----------]"
	const width = 10
	const filled = Math.min(width, Math.max(0, Math.round((index / total) * width)))
	return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000))
	const m = Math.floor(s / 60)
	const h = Math.floor(m / 60)
	if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}m`
	if (m > 0) return `${m}m${String(s % 60).padStart(2, "0")}s`
	return `${s}s`
}

function shortUrl(url: string): string {
	try {
		const parsed = new URL(url)
		const clipped = `${parsed.pathname}${parsed.search}`
		return clipped.length > 72 ? `${clipped.slice(0, 69)}...` : clipped
	} catch {
		return url.length > 72 ? `${url.slice(0, 69)}...` : url
	}
}
