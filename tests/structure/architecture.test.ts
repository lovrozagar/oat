import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * The architecture rules AGENTS.md states hold in the code, and the numbers it gives are the ones
 * the linter enforces: a rule a contributor reads is a rule that fails when broken.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8")

/* A catch-all name says nothing about what a module does: name it for that instead. */
const VAGUE = /^(utils?|helpers?|misc)$/

/** Source files under `dirs`, as repository paths. */
function sources(dirs: readonly string[]): string[] {
	return dirs.flatMap((dir) =>
		readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name))
			.map((entry) => relative(ROOT, join(entry.parentPath, entry.name))),
	)
}

/** Each path with a directory or file named utils, helpers or misc. */
export function vagueNames(paths: readonly string[]): string[] {
	return paths.filter((path) => path.split("/").some((part) => VAGUE.test(part.replace(/(\.test)?\.(ts|mjs|js)$/, ""))))
}

/** Each file that re-exports a whole module with `export *`, as `path: line`. */
export function barrels(files: Readonly<Record<string, string>>): string[] {
	return Object.entries(files).flatMap(([path, text]) =>
		[...text.matchAll(/^export \* (as \w+ )?from .+$/gm)].map((match) => `${path}: ${match[0]}`),
	)
}

describe("the architecture rules", () => {
	it("find a vaguely named module and a whole-module re-export", () => {
		expect(vagueNames(["src/utils.ts", "src/spec/helpers/x.ts", "src/misc.test.ts", "src/runtime/utility.ts"])).toEqual(
			["src/utils.ts", "src/spec/helpers/x.ts", "src/misc.test.ts"],
		)
		expect(barrels({ "src/a.ts": 'export * from "./b.ts"\nexport { c } from "./c.ts"\n' })).toEqual([
			'src/a.ts: export * from "./b.ts"',
		])
	})

	it("hold in this repository: no utils, helpers or misc, and no export * anywhere", () => {
		const files = sources(["src", "lint", "labs"])
		expect(vagueNames(files)).toEqual([])
		expect(barrels(Object.fromEntries(files.map((path) => [path, readFileSync(join(ROOT, path), "utf8")])))).toEqual([])
	})

	it("are stated in AGENTS.md with the limits the linter enforces", () => {
		const lint = JSON.parse(readFileSync(join(ROOT, ".oxlintrc.json"), "utf8")) as { rules: Record<string, unknown> }
		const limit = (rule: string): number => (lint.rules[rule] as [string, number])[1]
		const maxParams = /const MAX = (\d+)/.exec(readFileSync(join(ROOT, "lint", "max-params.ts"), "utf8"))?.[1]
		const section = AGENTS.slice(AGENTS.indexOf("## Architecture rules"))
		expect(section.startsWith("## Architecture rules")).toBe(true)
		expect(section).toContain(`${limit("max-lines")} lines a file`)
		expect(section).toContain(`${limit("max-lines-per-function")} lines a function`)
		expect(section).toContain(`complexity ${limit("complexity")}`)
		expect(section).toContain(`nesting depth ${limit("max-depth")}`)
		expect(section).toContain(`${maxParams} parameters`)
		expect(section).toMatch(/errors, config\/types → security → spec/)
		expect(section).toContain("tests/targets/anyrow.md")
	})
})
