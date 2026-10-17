import { describe, expect, it } from "vitest"
import { rule } from "./index-purity.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

describe("oat/index-purity", () => {
	it("allows only named re-exports in an index", () => {
		const fixture = {
			"src/index.ts": [
				'export { run } from "./runtime/run.ts"',
				'export type { RunOptions } from "./runtime/run.ts"',
				'export { type A, b } from "./a.ts"',
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("flags a barrel export *, an import, a local declaration and any statement", () => {
		const fixture = {
			"src/runtime/checks/index.ts": [
				'export * from "./a.ts"',
				'export * as b from "./b.ts"',
				'import { c } from "./c.ts"',
				"export { c }",
				"export const d = 1",
				"export default c",
				"run()",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 6, 7])
	})

	it("leaves files that are not an index, and indexes outside src, alone", () => {
		const fixture = { "src/runtime/main.ts": "export const d = 1\n", "lint/index.ts": "export default {}\n" }
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		expect(oxlintReports("index-purity", { "src/index.ts": 'export * from "./a.ts"\n' }).length).toBe(1)
	})
})
