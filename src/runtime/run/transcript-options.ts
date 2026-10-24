/*
 * `transcript`, checked before the run sends anything: a memory budget that is a byte count, and a
 * spool folder that exists and the run can write. Either fault is a usage error naming the option.
 */

import { accessSync, constants, statSync } from "node:fs"
import { UsageError } from "../../errors/usage-error.ts"
import type { SpoolOptions } from "../transcript/spool.ts"

/** Throws a UsageError when `transcript` sets a budget or a folder the run cannot honor. */
export function assertTranscript(transcript: SpoolOptions | undefined): void {
	const memoryBytes = transcript?.memoryBytes
	if (memoryBytes !== undefined && !(Number.isSafeInteger(memoryBytes) && memoryBytes > 0)) {
		throw new UsageError(`transcript.memoryBytes must be a positive integer number of bytes, got ${memoryBytes}`)
	}
	const dir = transcript?.dir
	if (dir === undefined) return
	const reason = folderFault(dir)
	if (reason !== undefined) throw new UsageError(`transcript.dir ${dir} ${reason}`)
}

/* Why the run could not spool into `dir`, or nothing when it can. */
function folderFault(dir: string): string | undefined {
	const stat = statSync(dir, { throwIfNoEntry: false })
	if (stat === undefined) return "does not exist"
	if (!stat.isDirectory()) return "is not a directory"
	try {
		accessSync(dir, constants.W_OK)
		return undefined
	} catch {
		return "is not writable"
	}
}
