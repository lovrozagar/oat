import { describe, expect, it } from "vitest"
import { rule } from "./no-v8-ignore.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

describe("oat/no-v8-ignore", () => {
	it("flags v8, c8 and istanbul ignore hints anywhere", () => {
		const fixture = {
			"src/a.ts": "/* v8 ignore next */\nexport const a = 1\n// c8 ignore start\n/* istanbul ignore else */\n",
			"tests/b.test.ts": "/* V8 Ignore next */\n",
		}
		expect(reportsOf(rule, fixture).map(({ file, line }) => `${file}:${line}`)).toEqual([
			"src/a.ts:1",
			"src/a.ts:3",
			"src/a.ts:4",
			"tests/b.test.ts:1",
		])
	})

	it("leaves other comments alone", () => {
		expect(reportsOf(rule, { "src/a.ts": "// ignore this\n/* v8 is fast */\n" })).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		expect(oxlintReports("no-v8-ignore", { "src/a.ts": "/* v8 ignore next */\nexport const a = 1\n" }).length).toBe(1)
	})
})
