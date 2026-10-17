import { describe, expect, it } from "vitest"
import { rule } from "./exit-only-in-cli.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const SOURCE = [
	"export function stop(): void {",
	"\tprocess.exit(1)",
	"}",
	"export const code = process.exitCode",
	"export const other = () => runtime.exit(1)",
	"export const plain = () => exit(1)",
	'export const keyed = () => process["exit"](1)',
].join("\n")

const lines = (file: string): number[] => reportsOf(rule, { [file]: SOURCE }).map((report) => report.line)

describe("oat/exit-only-in-cli", () => {
	it("flags an exit outside the CLI, which would skip teardown and the report", () => {
		expect(lines("src/runtime/probe.ts")).toEqual([2, 7])
	})

	it("leaves the CLI, scripts and tests alone", () => {
		expect(lines("src/cli.ts")).toEqual([])
		expect(lines("src/cli/main.ts")).toEqual([])
		expect(lines("scripts/probe.ts")).toEqual([])
		expect(lines("src/runtime/probe.test.ts")).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const reports = oxlintReports("exit-only-in-cli", { "src/runtime/probe.ts": SOURCE })
		expect(reports.map((report) => report.line)).toEqual([2, 7])
	})
})
