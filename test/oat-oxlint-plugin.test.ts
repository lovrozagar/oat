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
