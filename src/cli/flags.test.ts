import { describe, expect, it } from "vitest"
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

	it("documents --parser, which the hand-written help left out", () => {
		expect(USAGE).toMatch(/--parser\s+conformance: the document and suite checks only/)
		expect(isKnownFlag("parser")).toBe(true)
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

describe("str and list", () => {
	it("read a flag's value, and a comma-separated one as trimmed items", () => {
		expect(str({ a: "x", b: true }, "a")).toBe("x")
		expect(str({ b: true }, "b")).toBeUndefined()
		expect(list({ ops: " a, ,b " }, "ops")).toEqual(["a", "b"])
		expect(list({}, "ops")).toBeUndefined()
	})
})
