/** When a progress snapshot is written: on change, on a forced phase, on a stall, and on a heartbeat. */

import { PROGRESS_GLOSSARY } from "./columns.ts"
import { STALL_MS } from "./fields.ts"
import { formatProgressLine } from "./format.ts"
import type { ProgressHandler, ProgressSnapshot } from "./types.ts"

export const HEARTBEAT_MS = 5_000

export interface ProgressPump {
	emit: ProgressHandler
	stop: () => void
}

export function progressEventKey(snap: ProgressSnapshot): string {
	const inflight = snap.inflight === undefined ? "" : `${snap.inflight.method} ${snap.inflight.url} ${snap.inflight.at}`
	const finished = snap.last === undefined ? "" : String(snap.last.at)
	return `${snap.phase}|${snap.entity ?? ""}|${snap.check ?? ""}|${snap.message ?? ""}|${inflight}|${finished}`
}

/** A snapshot every reader wants as it happens: the run's start and end, a call going out, a seed. */
function isForced(snap: ProgressSnapshot): boolean {
	return (
		snap.phase === "done" ||
		snap.phase === "load" ||
		snap.phase === "auth" ||
		snap.inflight !== undefined ||
		(snap.phase === "seed" && snap.check === undefined)
	)
}

function isStalled(snap: ProgressSnapshot): boolean {
	return snap.inflight === undefined && snap.last !== undefined && Date.now() - snap.last.at >= STALL_MS
}

/**
 * Deduped writer plus a 5s heartbeat. The heartbeat re-formats `latest` at `now` so
 * `idle_ms` climbs on the in-flight request (or on the last completed call after return).
 */
export function createProgressPump(
	startedAt: number,
	write: (snap: ProgressSnapshot, now: number) => void,
): ProgressPump {
	let latest: ProgressSnapshot | undefined
	let lastKey = ""
	let lastWrite = 0

	const flush = (snap: ProgressSnapshot): void => {
		const now = Date.now()
		write(snap, now)
		lastWrite = now
	}

	const timer = setInterval(() => {
		if (latest === undefined) return
		flush({ ...latest, elapsedMs: Date.now() - startedAt })
	}, HEARTBEAT_MS)
	timer.unref()

	return {
		emit(snap) {
			latest = snap
			const key = progressEventKey(snap)
			const keyChanged = key !== lastKey
			lastKey = key
			const stalled = isStalled(snap)
			const force = isForced(snap)
			const due = Date.now() - lastWrite >= 2_000
			if (force || keyChanged || stalled || due) flush(snap)
		},
		stop() {
			clearInterval(timer)
		},
	}
}

/** Progress lines for a terminal, glossary first, each handed to `write` with its newline. */
export function createProgressPrinter(write: (text: string) => void, startedAt = Date.now()): ProgressPump {
	let headed = false
	return createProgressPump(startedAt, (snap, now) => {
		if (!headed) {
			headed = true
			write(`${PROGRESS_GLOSSARY}\n`)
		}
		write(`${formatProgressLine(snap, now)}\n`)
	})
}
