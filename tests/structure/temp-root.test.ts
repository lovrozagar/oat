import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { removeStaleRuns } from "../support/temp-root.ts"

/* A killed run never removes its root; the next one clears roots a day old, and nothing else. */

describe("removeStaleRuns", () => {
	it("removes run roots older than a day and keeps fresh ones and anything else", () => {
		const base = mkdtempSync(join(tmpdir(), "oat-roots-"))
		const day = 24 * 60 * 60 * 1000
		const now = Date.now()
		for (const name of ["run-old", "run-fresh", "keep-old"]) mkdirSync(join(base, name))
		const old = new Date(now - 2 * day)
		utimesSync(join(base, "run-old"), old, old)
		utimesSync(join(base, "keep-old"), old, old)
		removeStaleRuns(base, now)
		expect(["run-old", "run-fresh", "keep-old"].map((name) => existsSync(join(base, name)))).toEqual([
			false,
			true,
			true,
		])
	})
})
