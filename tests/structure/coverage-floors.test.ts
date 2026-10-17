import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { floorProblems } from "../support/coverage-floors.ts"

/*
 * Coverage floors only rise, and every instrumented module has one. The bar is the last committed
 * floors file that differs from the one in the tree: a commit that lowers a floor fails from then
 * on, not only while it is uncommitted.
 */

const ROOT = join(import.meta.dirname, "..", "..")

function git(cwd: string, ...args: string[]): void {
	const done = spawnSync("git", args, { cwd, encoding: "utf8" })
	if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`)
}

/* A repository holding `files`, committed once per entry of `commits` in order. */
function repo(commits: ReadonlyArray<Record<string, string>>): string {
	const dir = mkdtempSync(join(tmpdir(), "oat-floors-"))
	git(dir, "init", "-q")
	git(dir, "config", "user.email", "test@oat.test")
	git(dir, "config", "user.name", "oat test")
	for (const files of commits) {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true })
			writeFileSync(join(dir, path), text)
		}
		git(dir, "add", "-A")
		git(dir, "commit", "-q", "-m", "step")
	}
	return dir
}

const two = (a: number, b: number): string =>
	`${JSON.stringify({ "src/a.ts": { lines: a }, "src/b.ts": { lines: b } })}\n`
const floors = (lines: number): string => `${JSON.stringify({ "src/a.ts": { lines } })}\n`

describe("coverage floors", () => {
	it("hold in this repository: none lowered, none missing", () => {
		expect(floorProblems(ROOT)).toEqual([])
	})

	it("catch a lowered floor after it is committed", () => {
		const dir = repo([
			{ "coverage-floors.json": floors(90), "src/a.ts": "export const a = 1\n" },
			{ "coverage-floors.json": floors(80) },
		])
		expect(floorProblems(dir)).toEqual(["src/a.ts: lines 90 → 80"])
	})

	it("catch a lowered floor even after a later commit raises another", () => {
		const dir = repo([
			{ "coverage-floors.json": two(90, 50), "src/a.ts": "", "src/b.ts": "" },
			{ "coverage-floors.json": two(80, 50) },
			{ "coverage-floors.json": two(80, 60) },
		])
		expect(floorProblems(dir)).toEqual(["src/a.ts: lines 90 → 80"])
	})

	it("catch a lowered floor before it is committed, and pass a raised one", () => {
		const dir = repo([{ "coverage-floors.json": floors(90), "src/a.ts": "export const a = 1\n" }])
		writeFileSync(join(dir, "coverage-floors.json"), floors(70))
		expect(floorProblems(dir)).toEqual(["src/a.ts: lines 90 → 70"])
		writeFileSync(join(dir, "coverage-floors.json"), floors(95))
		expect(floorProblems(dir)).toEqual([])
	})

	it("catch an instrumented module with no floor, and a floor dropped for a module that exists", () => {
		const dir = repo([
			{ "coverage-floors.json": floors(90), "src/a.ts": "export const a = 1\n" },
			{ "coverage-floors.json": "{}\n", "src/b.ts": "export const b = 1\n", "src/b.test.ts": "", "src/index.ts": "" },
		])
		expect(floorProblems(dir)).toEqual([
			"src/a.ts: floor removed while the module exists",
			"src/a.ts: instrumented, with no floor",
			"src/b.ts: instrumented, with no floor",
		])
	})

	it("let a moved module's old floor go once the new path has its own", () => {
		const dir = repo([{ "coverage-floors.json": floors(90), "src/a.ts": "export const a = 1\n" }])
		mkdirSync(join(dir, "src/moved"))
		git(dir, "mv", "src/a.ts", "src/moved/a.ts")
		writeFileSync(join(dir, "coverage-floors.json"), `${JSON.stringify({ "src/moved/a.ts": { lines: 90 } })}\n`)
		git(dir, "commit", "-q", "-am", "move")
		expect(existsSync(join(dir, "src/a.ts"))).toBe(false)
		expect(floorProblems(dir)).toEqual([])
	})

	it("refuse a shallow clone, which cannot show the bar", () => {
		const source = repo([{ "coverage-floors.json": floors(90), "src/a.ts": "" }, { "src/a.ts": "x" }])
		const shallow = mkdtempSync(join(tmpdir(), "oat-floors-shallow-"))
		git(shallow, "clone", "-q", "--depth", "1", `file://${source}`, ".")
		expect(() => floorProblems(shallow)).toThrow(/fetch-depth: 0/)
		expect(readFileSync(join(shallow, "coverage-floors.json"), "utf8")).toBe(floors(90))
	})
})
