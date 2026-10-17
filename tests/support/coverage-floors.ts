import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { instrumentedModules } from "./coverage-scope.ts"

/*
 * The coverage ratchet. Every version of the floors file, committed or in the tree, must hold each
 * floor of the version before it. Comparing only the newest pair would let a drop pass once a later
 * commit changed something else.
 */

const FILE = "coverage-floors.json"

type Floors = Record<string, Record<string, number>>

function git(root: string, args: readonly string[]): string {
	const done = spawnSync("git", args, { cwd: root, encoding: "utf8" })
	if (done.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.stderr}`)
	return done.stdout
}

/**
 * Every version of the floors, newest first: the tree's when it differs from the last commit, then
 * each committed one. Each must not go below the one after it.
 */
function versions(root: string, working: string): Floors[] {
	if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
		throw new Error("a shallow clone cannot show the committed floors: check out with fetch-depth: 0")
	}
	const shas = git(root, ["log", "--format=%H", "--", FILE]).split("\n").filter(Boolean)
	const committed = shas.map((sha) => git(root, ["show", `${sha}:${FILE}`]))
	const texts = committed[0] === working ? committed : [working, ...committed]
	return texts.map((text) => JSON.parse(text) as Floors)
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
	const history = versions(root, working)
	const now = JSON.parse(working) as Floors
	const drops = history.slice(0, -1).flatMap((newer, index) => lowered(history[index + 1] ?? {}, newer, root))
	const unfloored = instrumentedModules(root)
		.filter((file) => now[file] === undefined)
		.map((file) => `${file}: instrumented, with no floor`)
	return [...new Set([...drops, ...unfloored])].toSorted()
}
