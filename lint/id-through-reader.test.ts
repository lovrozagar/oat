import { describe, expect, it } from "vitest"
import { rule } from "./id-through-reader.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const SOURCE = [
	"declare const record: Record<string, unknown>",
	"declare const ctx: { identity: string }",
	"declare const identity: string",
	"export const a = String(record[ctx.identity])",
	"export const b = String(record[identity])",
	'export const c = String(record["name"])',
	"export const d = String(record.identity)",
	"export const e = String()",
	"export const f = String(identity)",
	"export const g = Number(record[identity])",
].join("\n")

const lines = (file: string): number[] => reportsOf(rule, { [file]: SOURCE }).map((report) => report.line)

describe("oat/id-through-reader", () => {
	it("reports an identity read as text without the reader", () => {
		expect(lines("src/runtime/checks.ts")).toEqual([4, 5])
	})

	it("allows it in the module that owns the reader", () => {
		expect(lines("src/runtime/world/records.ts")).toEqual([])
	})

	it("leaves the reference backend's own rows alone", () => {
		expect(lines("src/reference/listing/run.ts")).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const reports = oxlintReports("id-through-reader", { "src/runtime/checks.ts": SOURCE })
		expect(reports.map((report) => report.line)).toEqual([4, 5])
	})
})
