import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/*
 * Every temp folder a test makes lands under one root, removed when the suite ends. Tests reach
 * the system temp dir through `os.tmpdir()`, which reads TMPDIR, and the workers inherit it.
 * Without this, each run left its folders behind until the per-user /tmp quota ran out.
 */
export default function setup(): () => void {
	const previous = process.env["TMPDIR"]
	const root = mkdtempSync(join(tmpdir(), "oat-test-"))
	process.env["TMPDIR"] = root
	return () => {
		rmSync(root, { force: true, recursive: true })
		if (previous === undefined) delete process.env["TMPDIR"]
		else process.env["TMPDIR"] = previous
	}
}
