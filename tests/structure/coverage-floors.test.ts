import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * Coverage floors only rise. The committed floors are the bar: a metric below its committed value,
 * or a floor dropped for a module that still exists, is a hand edit lowering the bar, and fails.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const FILE = "coverage-floors.json"

type Floors = Record<string, Record<string, number>>

function committed(): Floors | null {
	const shown = spawnSync("git", ["show", `HEAD:${FILE}`], { cwd: ROOT, encoding: "utf8" })
	return shown.status === 0 ? (JSON.parse(shown.stdout) as Floors) : null
}

/** Each way `now` lowers `before`: a metric that fell, or a live module whose floor is gone. */
function lowered(before: Floors, now: Floors, exists: (file: string) => boolean): string[] {
	const problems: string[] = []
	for (const [file, metrics] of Object.entries(before)) {
		const current = now[file]
		if (current === undefined) {
			if (exists(file)) problems.push(`${file}: floor removed while the module exists`)
			continue
		}
		for (const [metric, value] of Object.entries(metrics)) {
			if ((current[metric] ?? 0) < value) problems.push(`${file}: ${metric} ${value} → ${current[metric] ?? 0}`)
		}
	}
	return problems
}

describe("coverage floors", () => {
	it("are never lowered below the committed ones", () => {
		const before = committed()
		expect(before).not.toBeNull()
		const now = JSON.parse(readFileSync(join(ROOT, FILE), "utf8")) as Floors
		expect(lowered(before ?? {}, now, (file) => existsSync(join(ROOT, file)))).toEqual([])
	})

	it("catch a fallen metric and a dropped floor, and allow a moved module's", () => {
		const before = { "a.ts": { lines: 90 }, "b.ts": { lines: 80 }, "gone.ts": { lines: 70 } }
		const now = { "a.ts": { lines: 85 }, "c.ts": { lines: 10 } }
		expect(lowered(before, now, (file) => file !== "gone.ts")).toEqual([
			"a.ts: lines 90 → 85",
			"b.ts: floor removed while the module exists",
		])
	})
})
