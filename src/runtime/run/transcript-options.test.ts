import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { UsageError } from "../../errors/usage-error.ts"
import { assertTranscript } from "./transcript-options.ts"

/* `transcript`, checked before the run sends anything: a budget that is a byte count, a spool folder it can write. */

describe("assertTranscript", () => {
	it("accepts no option, the defaults, a positive integer budget and a folder it can write", () => {
		const dir = mkdtempSync(join(tmpdir(), "oat-transcript-option-"))
		try {
			expect(() => assertTranscript(undefined)).not.toThrow()
			expect(() => assertTranscript({})).not.toThrow()
			expect(() => assertTranscript({ dir, memoryBytes: 1 })).not.toThrow()
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("refuses a budget that is not a positive integer, naming the option and the value", () => {
		for (const memoryBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => assertTranscript({ memoryBytes })).toThrow(UsageError)
			expect(() => assertTranscript({ memoryBytes })).toThrow(
				`transcript.memoryBytes must be a positive integer number of bytes, got ${memoryBytes}`,
			)
		}
	})

	it("refuses a folder that is missing, is a file, or cannot be written, naming the option and the reason", () => {
		const root = mkdtempSync(join(tmpdir(), "oat-transcript-option-"))
		try {
			const missing = join(root, "missing")
			expect(() => assertTranscript({ dir: missing })).toThrow(UsageError)
			expect(() => assertTranscript({ dir: missing })).toThrow(`transcript.dir ${missing} does not exist`)
			const file = join(root, "file")
			writeFileSync(file, "")
			expect(() => assertTranscript({ dir: file })).toThrow(`transcript.dir ${file} is not a directory`)
			const made = mkdtempSync(join(root, "ro-"))
			chmodSync(made, 0o500)
			expect(() => assertTranscript({ dir: made })).toThrow(`transcript.dir ${made} is not writable`)
			chmodSync(made, 0o700)
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})
})
