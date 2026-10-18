import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * A report is shared beyond the machine that ran it: it holds no stack frame and no absolute
 * path. Every report golden is one, so none may match.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const LEAK = /\n\s+at |\/home\/|\/Users\/|[A-Z]:\\\\/

function snapshots(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".snap"))
		.map((entry) => join(entry.parentPath, entry.name))
}

describe("reports", () => {
	it("hold no stack frame and no absolute path", () => {
		const files = snapshots("tests/regression/__snapshots__")
		expect(files.length).toBeGreaterThan(100)
		const leaking = files.filter((file) => LEAK.test(readFileSync(file, "utf8")))
		expect(leaking.map((file) => file.slice(ROOT.length + 1))).toEqual([])
	})

	it("catch the leaks they are meant to", () => {
		expect(LEAK.test("TypeError: boom\n    at run (/srv/oat/x.js:1:1)")).toBe(true)
		expect(LEAK.test("open '/home/someone/spec.yaml'")).toBe(true)
		expect(LEAK.test("open 'C:\\\\Users\\\\spec.yaml'")).toBe(true)
		expect(LEAK.test("http://reference.test/v1/notes")).toBe(false)
	})
})
