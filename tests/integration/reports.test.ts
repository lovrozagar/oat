import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { main } from "../../src/cli/main.ts"
import { bufferWriter } from "../../src/cli/writer.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { EXIT } from "../../src/runtime/exit.ts"

/*
 * What a run leaves for people and CI: `oat run --report junit` writes the matrix page, the JSON
 * report and JUnit XML into the run folder, and appends the job summary where GITHUB_STEP_SUMMARY
 * points. A clean reference passes all of them; one injected defect fails each the same way.
 */

const dirs: string[] = []
afterAll(async () => {
	vi.unstubAllEnvs()
	await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })))
})

interface Ran {
	code: number
	out: string
	runDir: string
	summary: string
}

/* `oat run --report junit` against the memory reference with `defects` injected, as a user calls it. */
async function runWith(defects: string[]): Promise<Ran> {
	const dir = await mkdtemp(join(tmpdir(), "oat-reports-"))
	dirs.push(dir)
	const server = await createMemoryServer({ defects })
	try {
		const config = join(dir, "oat.config.json")
		const spec = `${server.url}/v1/openapi/spec`
		await writeFile(config, JSON.stringify({ baseUrl: server.url, principals: PRINCIPALS, security: SECURITY, spec }))
		const summary = join(dir, "summary.md")
		vi.stubEnv("GITHUB_STEP_SUMMARY", summary)
		const writer = bufferWriter()
		const argv = ["run", "--config", config, "--out", join(dir, "runs"), "--report", "junit", "--quiet"]
		const code = await main(argv, { writer })
		const out = writer.text()
		const junit = /^ {2}junit: (.+)$/m.exec(out)?.[1]
		if (junit === undefined) throw new Error(`the run printed no junit path:\n${out}`)
		return { code, out, runDir: dirname(junit), summary: await readFile(summary, "utf8") }
	} finally {
		vi.unstubAllEnvs()
		await server.close()
	}
}

interface Report {
	schemaVersion: number
	outcome: { exitCode: number; result: string }
	findings: Array<{ check: string; verdict: string; operations?: string[] }>
}

/* Tags in order, each close matching the open before it: the well-formedness a CI parser needs. */
function balanced(xml: string): boolean {
	const open: string[] = []
	for (const [, close, name, self] of xml.matchAll(/<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>/g)) {
		if (self === "/") continue
		if (close === "") open.push(name as string)
		else if (open.pop() !== name) return false
	}
	return open.length === 0
}

/* The JUnit document's counts: the root's attributes, and the elements it holds. */
function junitCounts(xml: string) {
	const root = /<testsuites [^>]*tests="(\d+)" failures="(\d+)"/.exec(xml)
	const suiteTests = [...xml.matchAll(/<testsuite [^>]*tests="(\d+)"/g)].reduce((sum, m) => sum + Number(m[1]), 0)
	const failed = [...xml.matchAll(/<testcase classname="([^"]+)" name="([^"]+)"><failure /g)]
	return {
		cases: xml.match(/<testcase /g)?.length ?? 0,
		failed: failed.map((m) => `${m[1]} ${m[2]}`).toSorted(),
		failures: Number(root?.[2]),
		suiteTests,
		tests: Number(root?.[1]),
	}
}

async function artifacts(runDir: string): Promise<{ html: string; report: Report; xml: string }> {
	const [html, json, xml] = await Promise.all(
		["matrix.html", "oat-report.json", "junit.xml"].map((name) => readFile(join(runDir, name), "utf8")),
	)
	return { html: html as string, report: JSON.parse(json as string) as Report, xml: xml as string }
}

describe("the run folder's reports", () => {
	it("writes matrix.html, oat-report.json, junit.xml and the step summary for a clean run", async () => {
		const ran = await runWith([])
		expect(ran.code).toBe(EXIT.clean)
		const { html, report, xml } = await artifacts(ran.runDir)
		expect(html).toMatch(/^<!DOCTYPE html>/)
		expect(html).toMatch(/<title>oat matrix — [^<]*\btable\b[^<]*<\/title>/)
		expect(report.schemaVersion).toBe(1)
		expect(report.outcome).toMatchObject({ exitCode: EXIT.clean, result: "clean" })
		expect(report.findings.filter((finding) => finding.verdict === "BACKEND_BUG")).toEqual([])
		expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites /)
		expect(balanced(xml)).toBe(true)
		const counts = junitCounts(xml)
		expect(counts.tests).toBeGreaterThan(0)
		expect([counts.cases, counts.suiteTests, counts.failures, counts.failed]).toEqual([
			counts.tests,
			counts.tests,
			0,
			[],
		])
		expect(ran.summary).toMatch(/^## oat: clean \(exit 0\)\n/)
	}, 60_000)

	it("fails the injected defect's check in every report, with the exit code to match", async () => {
		const ran = await runWith(["FILTER_IGNORED"])
		expect(ran.code).toBe(EXIT.defects)
		const { report, xml } = await artifacts(ran.runDir)
		expect(report.outcome).toMatchObject({ exitCode: EXIT.defects, result: "defects" })
		const bugs = report.findings.filter((finding) => finding.verdict === "BACKEND_BUG")
		expect(new Set(bugs.map((finding) => finding.check))).toEqual(new Set(["filter.unknown-field-rejected"]))
		expect(balanced(xml)).toBe(true)
		const counts = junitCounts(xml)
		expect([counts.cases, counts.suiteTests]).toEqual([counts.tests, counts.tests])
		expect(counts.failures).toBe(bugs.length)
		const expected = bugs.flatMap((finding) => (finding.operations ?? []).map((op) => `${op} ${finding.check}`))
		expect(counts.failed).toEqual(expected.toSorted())
		expect(ran.summary).toMatch(/^## oat: defects \(exit 1\)\n/)
		expect(ran.summary).toContain("| BACKEND_BUG | table | `filter.unknown-field-rejected` |")
	}, 60_000)
})
