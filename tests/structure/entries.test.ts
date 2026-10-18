import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENTRY_POINTS } from "../support/coverage-scope.ts"

/*
 * Coverage skips a process's entry points, so each must stay provably thin: imports, re-exports and
 * one statement that calls into tested code. Anything more belongs in the module it calls.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const MAX_CODE_LINES = 5

function codeLines(source: string): string[] {
	return source
		.replaceAll(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, "").trim())
		.filter((line) => line !== "" && !line.startsWith("#!"))
}

function statements(lines: readonly string[]): string[] {
	return lines.filter((line) => !/^(?:import|export) .* from "[^"]+"$/.test(line))
}

describe("process entry points", () => {
	it.each(ENTRY_POINTS)("%s is imports and one call", (entry) => {
		const lines = codeLines(readFileSync(join(ROOT, entry), "utf8"))
		expect(lines.length).toBeLessThanOrEqual(MAX_CODE_LINES)
		const rest = statements(lines)
		expect(rest).toHaveLength(1)
		expect(rest[0]).toMatch(/^(?:if \(\w+\([^()]*\)\) )?(?:await )?\w+\([^()]*\)$/)
	})

	it("reads code the way it is meant to", () => {
		const thin = `#!/usr/bin/env node\n/* doc */\nimport { start } from "./main.ts"\n// note\nstart()\n`
		expect(statements(codeLines(thin))).toEqual(["start()"])
		const fat = `import { a } from "./a.ts"\nconst x = a()\nx.run()\n`
		expect(statements(codeLines(fat))).toEqual(["const x = a()", "x.run()"])
	})
})
