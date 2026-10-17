import { describe, expect, it } from "vitest"
import { rule } from "./grammar-through-renderer.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const SOURCE = [
	"declare const c: { grammar: string; sortGrammar: string; name: string }",
	'export const a = c.grammar === "postgrest"',
	'export const b = c.sortGrammar !== "dotted"',
	'export const d = "colon" === c.grammar',
	"export const e = c.grammar === undefined",
	'export const f = c.name === "postgrest"',
	'export const g = c.grammar == "postgrest"',
	'export const h = c["sortGrammar"] === "dotted"',
	'export const i = c[key] === "dotted"',
].join("\n")

const lines = (file: string): number[] => reportsOf(rule, { [file]: SOURCE }).map((report) => report.line)

describe("oat/grammar-through-renderer", () => {
	it("flags a check that branches on a grammar's name instead of asking the renderer", () => {
		expect(lines("src/runtime/probe.ts")).toEqual([2, 3, 4, 8])
		expect(lines("src/report/probe.ts")).toEqual([2, 3, 4, 8])
	})

	it("leaves the renderer, the reference backend and tests alone", () => {
		expect(lines("src/spec/conventions.ts")).toEqual([])
		expect(lines("src/spec/filter-render.ts")).toEqual([])
		expect(lines("src/reference/dialect.ts")).toEqual([])
		expect(lines("src/runtime/probe.test.ts")).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const reports = oxlintReports("grammar-through-renderer", { "src/runtime/probe.ts": SOURCE })
		expect(reports.map((report) => report.line)).toEqual([2, 3, 4, 8])
	})
})
