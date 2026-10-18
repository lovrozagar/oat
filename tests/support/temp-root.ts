import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/*
 * Every temp folder a test makes lands under one root, removed when the suite ends. Tests reach
 * the system temp dir through `os.tmpdir()`, which reads TMPDIR, and the workers inherit it.
 *
 * The root is a per-user cache folder, not /tmp: /tmp is shared with every other process, and a
 * full per-user quota there once failed the goldens with EDQUOT. It is not under the repository
 * either, because oxlint applies a checkout's .gitignore and would lint nothing in the rule tests'
 * fixtures there.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Removes `run-*` roots under `base` last touched a day before `now`: a killed run never cleans up. */
export function removeStaleRuns(base: string, now: number): void {
	for (const name of readdirSync(base)) {
		if (!name.startsWith("run-")) continue
		const path = join(base, name)
		if (now - statSync(path).mtimeMs > DAY_MS) rmSync(path, { force: true, recursive: true })
	}
}

export default function setup(): () => void {
	const previous = process.env["TMPDIR"]
	const base = join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "oat-tests")
	mkdirSync(base, { recursive: true })
	removeStaleRuns(base, Date.now())
	const root = mkdtempSync(join(base, "run-"))
	process.env["TMPDIR"] = root
	return () => {
		rmSync(root, { force: true, recursive: true })
		if (previous === undefined) delete process.env["TMPDIR"]
		else process.env["TMPDIR"] = previous
	}
}
