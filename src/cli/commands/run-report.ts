import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { exchangeFilesFromIndex, renderConfidenceHtml } from "../../report/confidence.ts"
import { renderMatrixGraph, renderMatrixHtml } from "../../report/matrix.ts"
import {
	ISSUE_REPRO_DIR,
	renderConsole,
	renderJson,
	renderMarkdown,
	renderRepros,
	type ReportInput,
} from "../../report/render.ts"
import type { RunResult } from "../../runtime/run/index.ts"
import { renderTeardown } from "../../runtime/teardown.ts"
import type { Writer } from "../writer.ts"

/** What a finished run reports: the result, and where and when it ran. */
export interface Finished {
	result: RunResult
	baseUrl: string
	startedAt: Date
	durationMs: number
	outDir: string
}

/** The report's input: the result as the renderers read it. */
export function reportInput({ result, baseUrl, startedAt, durationMs }: Finished): ReportInput {
	return {
		baseUrl,
		checkNotes: result.checkNotes,
		checkTimings: result.checkTimings,
		checksOutOfScope: result.checksOutOfScope,
		checksRun: result.checksRun,
		checksSkipped: result.checksSkipped,
		checksSuppressed: result.checksSuppressed,
		client: result.client,
		durationMs,
		entitiesTested: result.entitiesTested,
		findings: result.findings,
		inconclusive: result.inconclusive,
		model: result.model,
		profile: result.profile,
		profileExclusions: result.profileExclusions,
		scope: result.scope,
		startedAt,
		teardown: result.teardown,
		...(result.exchanges === undefined ? {} : { exchanges: result.exchanges }),
		...(result.network === undefined ? {} : { network: result.network }),
		...(result.fenced === undefined ? {} : { fenced: result.fenced }),
		...(result.interrupted === true ? { interrupted: true } : {}),
		...(result.baseline === undefined ? {} : { baseline: result.baseline }),
		...(result.targetVersion === undefined ? {} : { targetVersion: result.targetVersion }),
	}
}

/**
 * Every file of the run folder: the credentials as they stood, the reports in markdown and JSON,
 * the matrix, the confidence page over the journaled exchanges, and a repro script per finding.
 */
export async function writeReports(finished: Finished, input: ReportInput): Promise<void> {
	const { result, outDir, baseUrl, startedAt } = finished
	const at = (name: string): string => resolve(outDir, name)
	await writeFile(at("principals.json"), `${JSON.stringify({ principals: result.principals }, null, 2)}\n`)
	await writeFile(at("oat-report.md"), renderMarkdown(input))
	await writeFile(at("oat-report.json"), renderJson(input))
	await writeFile(at("matrix.html"), renderMatrixHtml(input))
	await writeFile(at("matrix.json"), renderMatrixGraph(input))
	const index = at("exchanges.jsonl")
	const files = existsSync(index) ? exchangeFilesFromIndex(readFileSync(index, "utf8")) : new Map<number, string>()
	await writeFile(
		at("report.html"),
		renderConfidenceHtml({ baseUrl, generatedAt: startedAt.toISOString(), scope: result.scope }, files),
	)
	const scripts = renderRepros(result.findings, baseUrl, result.client.redactor)
	if (scripts.length === 0) return
	await mkdir(at(ISSUE_REPRO_DIR), { recursive: true })
	for (const script of scripts)
		await writeFile(resolve(at(ISSUE_REPRO_DIR), script.filename), script.content, { mode: 0o755 })
}

/** The console summary: the report, teardown, and where every file is. */
export function printSummary(writer: Writer, finished: Finished, input: ReportInput): void {
	const { result, outDir } = finished
	const at = (name: string): string => resolve(outDir, name)
	writer.out(renderConsole(input))
	const teardown = result.teardown ?? { failed: [], records: [], removed: 0, unidentified: [], unsupported: [] }
	for (const line of renderTeardown(teardown, result.created)) writer.out(`${line}\n`)
	writer.out(`  confidence: ${at("report.html")}\n`)
	writer.out(`  report: ${at("oat-report.md")}\n`)
	writer.out(`  matrix: ${at("matrix.html")}\n`)
	writer.out(`  graph:  ${at("matrix.json")}\n`)
	writer.out(`  progress: ${at("progress.log")} · ${at("progress.jsonl")}\n`)
	if (result.exchanges !== undefined) writer.out(`  exchanges: ${result.exchanges.count} → ${at("exchanges")}\n`)
	if (result.network?.incomplete === true) writer.out(`  network: ${result.network.kind} — run incomplete\n`)
}
