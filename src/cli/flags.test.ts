import { describe, expect, it } from "vitest"
import { DIALECTS } from "../reference/dialect/presets.ts"
import { COMMANDS, FLAGS, isKnownFlag, list, parseArgs, str, unknownFlag, USAGE } from "./flags.ts"

/*
 * The command line from one table: argv parses against it, and the help is printed from it, so a
 * flag the parser knows cannot be missing from the help.
 */

describe("USAGE", () => {
	it("names every command and every flag, with its value", () => {
		for (const { usage } of COMMANDS) expect(USAGE).toContain(`oat ${usage}`)
		for (const [name, spec] of Object.entries(FLAGS)) {
			const flag = `--${name}${spec.value === undefined ? "" : ` ${spec.value}`}`
			const line = USAGE.split("\n").find((text) => text.trimStart().startsWith(`${flag} `))
			expect({ name, line }).toEqual({ name, line: expect.stringContaining(spec.help) })
		}
	})

	it("sets every command's help apart from its usage, however long the longest usage is", () => {
		for (const { usage, help } of COMMANDS) {
			const line = USAGE.split("\n").find((text) => text.startsWith(`  oat ${usage} `)) ?? ""
			expect({ usage, gap: line.slice(`  oat ${usage}`.length) }).toEqual({
				usage,
				gap: expect.stringMatching(/^ {2,}\S/),
			})
			expect(line.endsWith(help)).toBe(true)
		}
	})

	it("documents --parser, which the hand-written help left out", () => {
		expect(USAGE).toMatch(/--parser\s+conformance: the document and suite checks only/)
		expect(isKnownFlag("parser")).toBe(true)
	})

	/* A dialect `--dialect` accepts but the help does not name is one nobody finds. */
	it("names every dialect the reference speaks on the --dialect line", () => {
		const line = USAGE.split("\n").find((text) => text.trimStart().startsWith("--dialect")) ?? ""
		for (const name of Object.keys(DIALECTS)) expect(line).toContain(name)
	})
})

describe("parseArgs", () => {
	it("reads a command, its flags in every form, and its positionals", () => {
		expect(parseArgs(["diff", "a", "--json", "b", "--out=x", "--seed", "3", "--fuzz"])).toEqual({
			command: "diff",
			flags: { fuzz: true, json: true, out: "x", seed: "3" },
			positionals: ["a", "b"],
		})
		expect(parseArgs([])).toEqual({ command: "help", flags: {} })
		expect(parseArgs(["--help"])).toEqual({ command: "help", flags: { help: true } })
		expect(parseArgs(["run", "--fuzz", "5"]).flags.fuzz).toBe("5")
	})

	it("reports the first problem and keeps reading", () => {
		expect(parseArgs(["run", "--quiet=yes"]).error).toBe("--quiet takes no value")
		expect(parseArgs(["run", "--config"]).error).toBe("--config needs a value")
		expect(parseArgs(["run", "--config", "--quiet"])).toMatchObject({
			error: "--config needs a value",
			flags: { config: true, quiet: true },
		})
		expect(parseArgs(["run", "--seed", "abc", "--jobs", "0"]).error).toBe('--seed must be an integer, got "abc"')
		expect(parseArgs(["run", "--jobs=0"]).error).toBe('--jobs must be a positive integer, got "0"')
		expect(parseArgs(["run", "--seed", " "]).error).toBe('--seed must be an integer, got " "')
		expect(parseArgs(["run", "--seed=-2"]).error).toBeUndefined()
	})

	it("takes an unknown flag's value inline only, leaving the check to unknownFlag", () => {
		const parsed = parseArgs(["run", "--concurrency=4", "--whatever", "x"])
		expect(parsed.flags).toEqual({ concurrency: "4", whatever: true })
		expect(parsed.positionals).toEqual(["x"])
		expect(unknownFlag(parsed.flags)).toBe("concurrency")
		expect(unknownFlag({ json: true })).toBeUndefined()
	})
})

describe("--report", () => {
	it("takes a comma-separated list of report names, read with list()", () => {
		const parsed = parseArgs(["run", "--report", "junit, junit", "--quiet"])
		expect(parsed.error).toBeUndefined()
		expect(list(parsed.flags, "report")).toEqual(["junit", "junit"])
		expect(parseArgs(["run", "--report=junit"]).flags.report).toBe("junit")
		expect(parseArgs(["run", "--report"]).error).toBe("--report needs a value")
		expect(USAGE).toMatch(/--report <names>\s+run: .*junit writes junit\.xml in the run directory/)
	})
})

describe("str and list", () => {
	it("read a flag's value, and a comma-separated one as trimmed items", () => {
		expect(str({ a: "x", b: true }, "a")).toBe("x")
		expect(str({ b: true }, "b")).toBeUndefined()
		expect(list({ ops: " a, ,b " }, "ops")).toEqual(["a", "b"])
		expect(list({}, "ops")).toBeUndefined()
	})
})
