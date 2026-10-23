import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { run } from "../../runtime/run/index.ts"
import type { RunResult } from "../../runtime/run/index.ts"
import { notesApi, optionsFor, overriding } from "../../runtime/run/__fixtures__/api.ts"
import { bufferWriter } from "../writer.ts"
import { folder } from "../__fixtures__/files.ts"
import {
	appendStepSummary,
	type Finished,
	keepCredentials,
	printSummary,
	reportInput,
	writeReports,
} from "./run-report.ts"

/* A finished run, written down: every file of the run folder, and the summary on the terminal. */

async function finishedRun(result: RunResult): Promise<Finished> {
	return { baseUrl: "http://api.test", durationMs: 12, outDir: folder(), result, startedAt: new Date(0) }
}

describe("reportInput", () => {
	it("carries everything the result has, and leaves out what it does not", async () => {
		const result = await run(optionsFor(notesApi()))
		const input = reportInput(await finishedRun(result))
		expect(input).toMatchObject({ baseUrl: "http://api.test", durationMs: 12, entitiesTested: ["note"] })
		for (const key of ["exchanges", "network", "fenced", "interrupted", "baseline", "targetVersion"])
			expect(input).not.toHaveProperty(key)
		const full = reportInput(
			await finishedRun({
				...result,
				baseline: { fixed: [] },
				exchanges: { count: 1 },
				fenced: { failRun: true, requests: [] },
				interrupted: true,
				network: { attempts: 1, incomplete: true, kind: "dns", url: "u", waitedMs: 0 },
				targetVersion: { value: "b" },
			}),
		)
		expect(full).toMatchObject({
			baseline: { fixed: [] },
			exchanges: { count: 1 },
			interrupted: true,
			targetVersion: { value: "b" },
		})
	})
})

describe("writeReports and printSummary", () => {
	it("writes the reports, and a repro script per finding", async () => {
		const crashing = overriding(notesApi(), (method, path) =>
			method === "PATCH" && path.startsWith("/notes/") ? { status: 500 } : undefined,
		)
		const finished = await finishedRun(await run(optionsFor(crashing)))
		const input = reportInput(finished)
		await writeReports(finished, input)
		const written = ["principals.json", "oat-report.md", "oat-report.json", "matrix.html", "matrix.json", "report.html"]
		expect(written.filter((name) => !existsSync(join(finished.outDir, name)))).toEqual([])
		const repros = readdirSync(finished.outDir).filter((name) => !name.includes("."))
		expect(repros).toHaveLength(1)
		const writer = bufferWriter()
		printSummary(writer, finished, input)
		expect(writer.text()).toContain(`  report: ${join(finished.outDir, "oat-report.md")}\n`)
		expect(writer.text()).not.toContain("exchanges:")
	})

	it("reads the journaled exchanges into the confidence page, and says where they are", async () => {
		const outDir = folder()
		const result = await run(optionsFor(notesApi(), { exchangeDir: outDir }))
		const finished = { ...(await finishedRun(result)), outDir }
		const input = reportInput(finished)
		await writeReports(finished, input)
		expect(readFileSync(join(outDir, "report.html"), "utf8").length).toBeGreaterThan(0)
		const writer = bufferWriter()
		printSummary(writer, finished, input)
		expect(writer.text()).toMatch(/ {2}exchanges: \d+ → /)
	})
})

describe("writeReports, the optional reports", () => {
	it("writes junit.xml only when asked", async () => {
		const plain = await finishedRun(await run(optionsFor(notesApi())))
		const input = reportInput(plain)
		await writeReports(plain, input)
		expect(existsSync(join(plain.outDir, "junit.xml"))).toBe(false)
		const quiet = bufferWriter()
		printSummary(quiet, plain, input)
		expect(quiet.text()).not.toContain("junit:")
		const asked: Finished = { ...plain, formats: ["junit"], outDir: folder() }
		await writeReports(asked, input)
		expect(readFileSync(join(asked.outDir, "junit.xml"), "utf8")).toMatch(/^<\?xml version="1.0"/)
		const writer = bufferWriter()
		printSummary(writer, asked, input)
		expect(writer.text()).toContain(`  junit: ${join(asked.outDir, "junit.xml")}\n`)
	})
})

describe("writeReports and printSummary, a quiet run", () => {
	it("writes no repro folder for a run that found nothing", async () => {
		const finished = await finishedRun({ ...(await run(optionsFor(notesApi()))), findings: [] })
		await writeReports(finished, reportInput(finished))
		expect(readdirSync(finished.outDir).filter((name) => !name.includes("."))).toEqual([])
	})

	it("says a run the network cut short is incomplete, and summarizes no teardown as none", async () => {
		const result = await run(optionsFor(notesApi()))
		const finished = await finishedRun({
			...result,
			network: { attempts: 1, incomplete: true, kind: "dns", url: "u", waitedMs: 0 },
			teardown: null,
		})
		const writer = bufferWriter()
		printSummary(writer, finished, reportInput(finished))
		expect(writer.text()).toContain("  network: dns — run incomplete\n")
	})
})

describe("appendStepSummary", () => {
	it("appends the summary to the file GitHub names, and does nothing without one", async () => {
		const finished = await finishedRun(await run(optionsFor(notesApi())))
		const input = reportInput(finished)
		const path = join(folder(), "summary.md")
		writeFileSync(path, "earlier step\n")
		const writer = bufferWriter()
		await appendStepSummary(writer, input, { path, runDir: finished.outDir })
		await appendStepSummary(writer, input, { path: undefined, runDir: finished.outDir })
		await appendStepSummary(writer, input, { path: "", runDir: finished.outDir })
		const text = readFileSync(path, "utf8")
		expect(text.startsWith("earlier step\n## oat: ")).toBe(true)
		expect(text).toContain(`Full report: \`${join(finished.outDir, "oat-report.md")}\``)
		expect(writer.text()).toBe("")
	})

	it("warns when the summary cannot be written", async () => {
		const finished = await finishedRun(await run(optionsFor(notesApi())))
		const writer = bufferWriter()
		const path = join(folder(), "missing", "summary.md")
		await appendStepSummary(writer, reportInput(finished), { path, runDir: finished.outDir })
		expect(writer.text()).toMatch(/^oat: could not write the step summary: ENOENT/)
	})
})

describe("credentials", () => {
	const kept = [{ expiresAt: null, principal: "alpha", scheme: "bearer", scopes: [], value: "alpha-key" }]

	it("writes principals.json readable by its owner alone, holding no credential value", async () => {
		const finished = await finishedRun({ ...(await run(optionsFor(notesApi()))), credentials: kept })
		await writeReports(finished, reportInput(finished))
		const path = join(finished.outDir, "principals.json")
		expect(statSync(path).mode & 0o777).toBe(0o600)
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ principals: finished.result.principals })
		expect(readFileSync(path, "utf8")).not.toContain("alpha-key")
	})

	it("writes the values a run kept, readable by its owner alone, and nothing for a run that kept none", async () => {
		const result = await run(optionsFor(notesApi()))
		const path = join(folder(), ".oat", "credentials.json")
		expect(await keepCredentials({ ...result, credentials: kept }, path)).toBe(true)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ credentials: kept })
		const elsewhere = join(folder(), "credentials.json")
		expect(await keepCredentials(result, elsewhere)).toBe(false)
		expect(existsSync(elsewhere)).toBe(false)
	})
})
