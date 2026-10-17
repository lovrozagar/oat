import { describe, expect, it } from "vitest"
import { rule } from "./no-module-state.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const MESSAGE =
	"module-scope state needs `// per-process-constant: <reason>` with an allowlisted reason (" +
	"compiled-schema, async-context)"

describe("oat/no-module-state: what is state", () => {
	it("flags module-scope let, var and constructed objects in src", () => {
		const fixture = {
			"src/runtime/a.ts": "let count = 0\nexport var flag = true\nexport const memo = new WeakMap()\n",
			"src/spec/b.ts":
				"export const map = new Map() as Map<string, number>\nconst set = (new Set())\nconst typed: Set<string> = new Set()\n",
		}
		expect(reportsOf(rule, fixture).map(({ file, line }) => `${file}:${line}`)).toEqual([
			"src/runtime/a.ts:1",
			"src/runtime/a.ts:2",
			"src/runtime/a.ts:3",
			"src/spec/b.ts:1",
			"src/spec/b.ts:2",
			"src/spec/b.ts:3",
		])
		expect(reportsOf(rule, fixture)[0]?.message).toBe(MESSAGE)
	})

	it("allows plain constants, function scope and an allowlisted reason on or above the line", () => {
		const fixture = {
			"src/runtime/a.ts": [
				"export const LIMIT = 3",
				"const names = [1, 2]",
				"export function f() { let x = new Map(); return x }",
				"// per-process-constant: async-context",
				"let signal = 0",
				'export const METHODS: ReadonlySet<string> = new Set(["GET"])',
				"const BY_ID: ReadonlyMap<string, number> = new Map()",
				"const ajv = new Map() // per-process-constant: compiled-schema",
				"export const other = new Set() /* per-process-constant: compiled-schema */",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})
})

describe("oat/no-module-state: reasons and scope", () => {
	it("rejects an unlisted reason, a reason on a later line, and a comment that is not a reason", () => {
		const fixture = {
			"src/runtime/a.ts": [
				"// per-process-constant: convenience",
				"let a = 0",
				"let b = 0",
				"// per-process-constant: async-context",
				"// unrelated",
				"let c = 0",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([2, 3, 6])
	})

	it("leaves tests, fixtures and code outside src alone", () => {
		const fixture = {
			"src/runtime/a.test.ts": "let x = 0\n",
			"src/runtime/__fixtures__/a.ts": "let x = 0\n",
			"tests/integration/a.test.ts": "let x = 0\n",
			"labs/demo.ts": "let x = 0\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const source = "let x = 0\nexport const S: ReadonlySet<string> = new Set()\nconst m = new Map()\n"
		const reports = oxlintReports("no-module-state", { "src/runtime/a.ts": source })
		expect(reports.map(({ line }) => line)).toEqual([1, 3])
	})
})
