import { createWriteStream, writeFileSync } from "node:fs"
import { finished } from "node:stream/promises"
import { resolve } from "node:path"
import { createProgressPrinter, createProgressPump } from "../../runtime/progress/pump.ts"
import { formatProgressJsonl, formatProgressLine, formatProgressTsv } from "../../runtime/progress/format.ts"
import { PROGRESS_GLOSSARY, PROGRESS_TSV_HEADER } from "../../runtime/progress/columns.ts"
import type { ProgressSnapshot } from "../../runtime/progress/types.ts"
import type { Writer } from "../writer.ts"

/** Where a run's live status goes, and how it is closed once the run ends. */
export interface RunProgressOut {
	onProgress(snap: ProgressSnapshot): void
	/** Stops the status and shuts the files: resolved once every one is written, however often it is called. */
	close(): Promise<void>
}

/** How often `progress.json`, the one file read while the run goes on, is rewritten. */
const JSON_EVERY_MS = 1_000

/**
 * The run's status: a line on stderr unless `quiet`, and in the run folder `progress.log` (with
 * its glossary), `progress.tsv`, `progress.jsonl`, and `progress.json` for what is happening now.
 */
/** When the run started, and whether its stderr line stays quiet. */
export interface ProgressOptions {
	startedAt: number
	quiet: boolean
}

export function runProgress(writer: Writer, outDir: string, { quiet, startedAt }: ProgressOptions): RunProgressOut {
	const stderr = quiet ? undefined : createProgressPrinter(writer.err, startedAt)
	const log = createWriteStream(resolve(outDir, "progress.log"))
	const tsv = createWriteStream(resolve(outDir, "progress.tsv"))
	const jsonl = createWriteStream(resolve(outDir, "progress.jsonl"))
	log.write(`${PROGRESS_GLOSSARY}\n`)
	tsv.write(`${PROGRESS_TSV_HEADER}\n`)
	let lastJsonAt = 0
	const files = createProgressPump(startedAt, (snap, now) => {
		log.write(`${formatProgressLine(snap, now)}\n`)
		tsv.write(`${formatProgressTsv(snap, now)}\n`)
		jsonl.write(`${formatProgressJsonl(snap, now)}\n`)
		if (now - lastJsonAt < JSON_EVERY_MS && snap.phase !== "done") return
		lastJsonAt = now
		writeFileSync(resolve(outDir, "progress.json"), `${JSON.stringify(current(snap, now), null, 2)}\n`)
	})
	let closing: Promise<void> | undefined
	return {
		close: () => {
			closing ??= (() => {
				stderr?.stop()
				files.stop()
				return Promise.all([log, tsv, jsonl].map((stream) => finished(stream.end()))).then(() => undefined)
			})()
			return closing
		},
		onProgress: (snap) => {
			stderr?.emit(snap)
			files.emit(snap)
		},
	}
}

/** The status as `progress.json` states it: how long since the run last heard anything, and when. */
function current(
	snap: ProgressSnapshot,
	now: number,
): ProgressSnapshot & { lastAgoMs: number | null; updatedAt: string } {
	const ageFrom = snap.inflight?.at ?? snap.last?.at
	return { ...snap, lastAgoMs: ageFrom === undefined ? null : now - ageFrom, updatedAt: new Date(now).toISOString() }
}
