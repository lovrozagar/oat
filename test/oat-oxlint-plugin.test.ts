import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/*
 * Runs the real oxlint with only the rule under test on, against probe files written to a temp
 * directory, so the test covers the plugin exactly as `.oxlintrc.json` loads it.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..")
const PLUGIN = join(REPO_ROOT, "lint", "oat.oxlint-plugin.ts")
const workdir = mkdtempSync(join(tmpdir(), "oat-oxlint-plugin-"))

afterAll(() => rmSync(workdir, { force: true, recursive: true }))

interface Diagnostic {
	code: string
	labels: Array<{ span: { line: number } }>
}

function lint(relativePath: string, source: string, rule: string): number[] {
	const file = join(workdir, relativePath)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, source)
	const config = join(workdir, "oxlintrc.json")
	writeFileSync(config, JSON.stringify({ categories: {}, jsPlugins: [PLUGIN], rules: { [`oat/${rule}`]: "error" } }))
	const result = spawnSync("bunx", ["oxlint", "-c", config, "-f", "json", file], { cwd: REPO_ROOT, encoding: "utf8" })
	if (!result.stdout.trimStart().startsWith("{")) {
		throw new Error(`oxlint did not report: ${result.stdout}${result.stderr}`.trim())
	}
	const report: { diagnostics: Diagnostic[] } = JSON.parse(result.stdout)
	return report.diagnostics
		.filter((diagnostic) => diagnostic.code === `oat(${rule})`)
		.map((diagnostic) => diagnostic.labels[0]?.span.line ?? 0)
}

describe("oat/proven-id-origin", () => {
	const source = [
		'import type { ProvenId } from "./proven-id.ts"',
		"declare const sent: string",
		"export const a = sent as ProvenId",
		"export const b = <ProvenId>sent",
		"export const c = sent as string",
		"export const d = 1 as number",
		'export const e = sent as import("./proven-id.ts").ProvenId',
		"export const f = sent as NotProvenId",
	].join("\n")

	it("reports a cast to ProvenId in both syntaxes and qualified, and nothing else", () => {
		expect(lint("src/runtime/checks.ts", source, "proven-id-origin")).toEqual([3, 4, 7])
	})

	it("allows the casts inside the module that owns the constructors", () => {
		expect(lint("src/runtime/proven-id.ts", source, "proven-id-origin")).toEqual([])
	})
})

describe("oat/network-through-client", () => {
	const source = [
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
	].join("\n")

	it("reports every way out of the process that is not the client", () => {
		expect(lint("src/runtime/checks.ts", source, "network-through-client")).toEqual([2, 3, 4, 5, 6])
	})

	it("allows the client itself, the reference backend and tests", () => {
		expect(lint("src/runtime/client.ts", source, "network-through-client")).toEqual([])
		expect(lint("src/reference/stores/sqlite-driver.ts", source, "network-through-client")).toEqual([])
		expect(lint("test/some.test.ts", source, "network-through-client")).toEqual([])
	})
})

describe("oat/grammar-through-renderer", () => {
	const source = [
		"declare const c: { grammar: string; sortGrammar: string }",
		'export const a = c.grammar === "postgrest"',
		'export const b = c.sortGrammar !== "dotted"',
		'export const d = "colon" === c.grammar',
		"export const e = c.grammar === undefined",
		'export const f = c.name === "postgrest"',
	].join("\n")

	it("flags a check that branches on a grammar's name instead of asking the renderer", () => {
		expect(lint("src/runtime/probe.ts", source, "grammar-through-renderer")).toEqual([2, 3, 4])
		expect(lint("src/report/probe.ts", source, "grammar-through-renderer")).toEqual([2, 3, 4])
	})

	it("leaves the renderer, the reference backend and tests alone", () => {
		expect(lint("src/spec/conventions.ts", source, "grammar-through-renderer")).toEqual([])
		expect(lint("src/spec/filter-render.ts", source, "grammar-through-renderer")).toEqual([])
		expect(lint("src/reference/dialect.ts", source, "grammar-through-renderer")).toEqual([])
		expect(lint("test/probe.test.ts", source, "grammar-through-renderer")).toEqual([])
	})
})

describe("oat/exit-only-in-cli", () => {
	const source = [
		"export function stop(): void {",
		"\tprocess.exit(1)",
		"}",
		"export const code = process.exitCode",
	].join("\n")

	it("flags an exit outside the CLI, which would skip teardown and the report", () => {
		expect(lint("src/runtime/probe.ts", source, "exit-only-in-cli")).toEqual([2])
	})

	it("leaves the CLI, scripts and tests alone", () => {
		expect(lint("src/cli.ts", source, "exit-only-in-cli")).toEqual([])
		expect(lint("scripts/probe.ts", source, "exit-only-in-cli")).toEqual([])
		expect(lint("test/probe.test.ts", source, "exit-only-in-cli")).toEqual([])
	})
})

describe("oat/id-through-reader", () => {
	const source = [
		"declare const record: Record<string, unknown>",
		"declare const ctx: { identity: string }",
		"declare const identity: string",
		"export const a = String(record[ctx.identity])",
		"export const b = String(record[identity])",
		'export const c = String(record["name"])',
		"export const d = String(record.identity)",
	].join("\n")

	it("reports an identity read as text without the reader", () => {
		expect(lint("src/runtime/checks.ts", source, "id-through-reader")).toEqual([4, 5])
	})

	it("allows it in the module that owns the reader", () => {
		expect(lint("src/runtime/world.ts", source, "id-through-reader")).toEqual([])
	})

	it("leaves the reference backend's own rows alone", () => {
		expect(lint("src/reference/listing.ts", source, "id-through-reader")).toEqual([])
	})
})
