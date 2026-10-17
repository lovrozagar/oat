import { describe, expect, it } from "vitest"
import { rule } from "./network-through-client.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const SOURCE = [
	'import * as http from "node:http"',
	'import { request } from "node:https"',
	'import { fetch as undiciFetch } from "undici"',
	'export const a = fetch("http://x.test")',
	'export const b = globalThis.fetch("http://x.test")',
	'export const c = http.request("http://x.test")',
	'export const d = request("http://x.test")',
	"export const e = http.createServer()",
	"export const f = (options: { fetchImpl?: typeof fetch }) => options.fetchImpl ?? fetch",
	'export const g = undiciFetch("http://x.test")',
	"export const h = globalThis.structuredClone({})",
	'export const i = (() => fetch)()("http://x.test")',
	'import { createServer } from "node:http"',
	'import { readFile } from "node:fs"',
	'export const j = https["get"]("http://x.test")',
	'import { "request" as r } from "node:http"',
	"export const k = http[method]()",
	'import def from "node:http"',
].join("\n")

const lines = (file: string): number[] => reportsOf(rule, { [file]: SOURCE }).map((report) => report.line)

describe("oat/network-through-client", () => {
	it("reports every way out of the process that is not the client", () => {
		expect(lines("src/runtime/checks.ts")).toEqual([2, 3, 4, 5, 6, 15, 16])
	})

	it("allows the client itself, the reference backend, labs and tests", () => {
		expect(lines("src/runtime/client.ts")).toEqual([])
		expect(lines("src/reference/stores/sqlite-driver.ts")).toEqual([])
		expect(lines("labs/demo.ts")).toEqual([])
		expect(lines("src/runtime/checks.test.ts")).toEqual([])
		expect(lines("tests/integration/some.test.ts")).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const reports = oxlintReports("network-through-client", { "src/runtime/checks.ts": SOURCE })
		expect(reports.map((report) => report.line)).toEqual([2, 3, 4, 5, 6, 15, 16])
	})
})
