import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { instrumentedModules } from "./coverage-scope.ts"

/*
 * The coverage ratchet. The bar is the last committed floors file that differs from the one in the
 * tree: HEAD's while the tree's is an uncommitted edit, the one before once that edit is committed.
 * Comparing with HEAD alone would let a committed drop pass on every later checkout.
 */

const FILE = "coverage-floors.json"

type Floors = Record<string, Record<string, number>>

function git(root: string, args: readonly string[]): string {
	const done = spawnSync("git", args, { cwd: root, encoding: "utf8" })
	if (done.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.stderr}`)
	return done.stdout
}

/** The floors the tree must not go below, or none when the file has no earlier version. */
function bar(root: string, working: string): Floors | null {
	if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
		throw new Error("a shallow clone cannot show the committed floors: check out with fetch-depth: 0")
	}
	const [head, previous] = git(root, ["log", "--format=%H", "-n", "2", "--", FILE]).split("\n").filter(Boolean)
	if (head === undefined) return null
	const atHead = git(root, ["show", `${head}:${FILE}`])
	if (atHead !== working) return JSON.parse(atHead) as Floors
	return previous === undefined ? null : (JSON.parse(git(root, ["show", `${previous}:${FILE}`])) as Floors)
}

/** Each way `now` lowers `before`: a metric that fell, or a floor dropped for a module that still exists. */
function lowered(before: Floors, now: Floors, root: string): string[] {
	const problems: string[] = []
	for (const [file, metrics] of Object.entries(before)) {
		const current = now[file]
		if (current === undefined) {
			if (existsSync(join(root, file))) problems.push(`${file}: floor removed while the module exists`)
			continue
		}
		for (const [metric, value] of Object.entries(metrics)) {
			if ((current[metric] ?? 0) < value) problems.push(`${file}: ${metric} ${value} → ${current[metric] ?? 0}`)
		}
	}
	return problems
}

/** Everything wrong with the floors in `root`: lowered against the bar, or missing for a module. */
export function floorProblems(root: string): string[] {
	const working = readFileSync(join(root, FILE), "utf8")
	const now = JSON.parse(working) as Floors
	const before = bar(root, working)
	const unfloored = instrumentedModules(root)
		.filter((file) => now[file] === undefined)
		.map((file) => `${file}: instrumented, with no floor`)
	return [...(before === null ? [] : lowered(before, now, root)), ...unfloored].toSorted()
}
