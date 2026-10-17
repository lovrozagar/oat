import { describe, expect, it } from "vitest"
import { rule } from "./no-console.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const MESSAGE = "terminal output belongs to src/cli/writer.ts; write through the writer"

describe("oat/no-console", () => {
	it("flags console and the process streams in src", () => {
		const fixture = {
			"src/runtime/a.ts": [
				'console.log("x")',
				'export const f = () => console["warn"]("x")',
				'process.stdout.write("x")',
				"export const err = process.stderr",
				'process["stdout"].write("x")',
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5])
		expect(reportsOf(rule, fixture)[0]?.message).toBe(MESSAGE)
	})

	it("allows the writer, tests and code outside src", () => {
		const fixture = {
			"src/cli/writer.ts": 'process.stdout.write("x")\nconsole.error("x")\n',
			"src/runtime/a.test.ts": 'console.log("x")\n',
			"tests/integration/a.test.ts": 'console.log("x")\n',
			"labs/demo.ts": 'console.log("x")\n',
			"src/runtime/b.ts":
				"export const n = process.env\nexport const c = logger.console\nexport const s = proc.stdout\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		expect(oxlintReports("no-console", { "src/runtime/a.ts": 'console.log("x")\n' }).length).toBe(1)
	})
})
