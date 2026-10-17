import { describe, expect, it } from "vitest"
import { rule } from "./proven-id-origin.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const SOURCE = [
	'import type { ProvenId } from "./proven-id.ts"',
	"declare const sent: string",
	"export const a = sent as ProvenId",
	"export const b = <ProvenId>sent",
	"export const c = sent as string",
	"export const d = 1 as number",
	'export const e = sent as import("./proven-id.ts").ProvenId',
	"export const f = sent as NotProvenId",
].join("\n")

const lines = (file: string): number[] => reportsOf(rule, { [file]: SOURCE }).map((report) => report.line)

describe("oat/proven-id-origin", () => {
	it("reports a cast to ProvenId in both syntaxes and qualified, and nothing else", () => {
		expect(lines("src/runtime/checks.ts")).toEqual([3, 4, 7])
	})

	it("allows the casts inside the module that owns the constructors", () => {
		expect(lines("src/runtime/proven-id.ts")).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const reports = oxlintReports("proven-id-origin", { "src/runtime/checks.ts": SOURCE })
		expect(reports.map((report) => report.line)).toEqual([3, 4, 7])
	})
})
