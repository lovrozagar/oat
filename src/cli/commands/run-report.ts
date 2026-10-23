import { existsSync, readFileSync } from "node:fs"
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { messageOf } from "../../errors/message.ts"
import { exchangeFilesFromIndex, renderConfidenceHtml } from "../../report/confidence.ts"
import { buildMatrixGraphFromReport, graphJson } from "../../report/matrix/graph.ts"
import { renderPoster } from "../../report/matrix/poster.ts"
import type { ReportInput } from "../../report/render/input.ts"
import { renderJson } from "../../report/render/json.ts"
import { renderJunit } from "../../report/render/junit.ts"
import { renderMarkdown } from "../../report/render/markdown.ts"
import { ISSUE_REPRO_DIR, renderRepros } from "../../report/render/repro.ts"
import { renderStepSummary } from "../../report/render/step-summary.ts"
import { renderConsole } from "../../report/render/summary.ts"
import type { RunResult } from "../../runtime/run/index.ts"
import { renderTeardown } from "../../runtime/teardown/render.ts"
import type { Writer } from "../writer.ts"

/** A report `--report` can add to the run folder. */
export type ReportFormat = "junit"

export const REPORT_FORMATS: readonly ReportFormat[] = ["junit"]

/** What a finished run reports: the result, and where and when it ran. */
export interface Finished {
	result: RunResult
	baseUrl: string
	startedAt: Date
	durationMs: number
	outDir: string
	/** The reports `--report` asked for beside the run's own; absent, none. */
	formats?: readonly ReportFormat[]
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

/** Where `--keep-credentials` writes, from the working directory: beside the default runs root, never in a run folder. */
export const KEPT_CREDENTIALS = ".oat/credentials.json"

/* Readable by its owner alone, even where the file was already there. */
async function writePrivate(path: string, text: string): Promise<void> {
	await writeFile(path, text, { mode: 0o600 })
	await chmod(path, 0o600)
}

/**
 * The credential values a run kept (`--keep-credentials`), written to `path`, which is never under
 * the output directory: a report is shared, and holds no credential. False when the run kept none.
 */
export async function keepCredentials(result: RunResult, path: string): Promise<boolean> {
	if (result.credentials === undefined) return false
	await mkdir(dirname(path), { recursive: true })
	await writePrivate(path, `${JSON.stringify({ credentials: result.credentials }, null, 2)}\n`)
	return true
}

/**
 * Every file of the run folder: the principals as they stood, holding no credential value, the reports in markdown and JSON,
 * JUnit XML when `--report junit` asked for it, the matrix (one graph, drawn as the poster and written as JSON), the
 * confidence page over the journaled exchanges, and a repro script per finding.
 */
export async function writeReports(finished: Finished, input: ReportInput): Promise<void> {
	const { result, outDir, baseUrl, startedAt } = finished
	const at = (name: string): string => resolve(outDir, name)
	await writePrivate(at("principals.json"), `${JSON.stringify({ principals: result.principals }, null, 2)}\n`)
	await writeFile(at("oat-report.md"), renderMarkdown(input))
	await writeFile(at("oat-report.json"), renderJson(input))
	if (junitAsked(finished)) await writeFile(at("junit.xml"), renderJunit(input))
	const graph = buildMatrixGraphFromReport(input)
	await writeFile(at("matrix.html"), renderPoster(graph))
	await writeFile(at("matrix.json"), graphJson(graph))
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

function junitAsked(finished: Finished): boolean {
	return finished.formats?.includes("junit") === true
}

/**
 * The run's job summary, appended to `path`: the file `GITHUB_STEP_SUMMARY` names inside GitHub
 * Actions. Nothing without one. A summary that cannot be written is a warning, never a different exit.
 */
export async function appendStepSummary(
	writer: Writer,
	input: ReportInput,
	where: { path: string | undefined; runDir: string },
): Promise<void> {
	const { path, runDir } = where
	if (path === undefined || path === "") return
	try {
		await appendFile(path, renderStepSummary(input, { runDir }))
	} catch (error) {
		writer.err(`oat: could not write the step summary: ${messageOf(error)}\n`)
	}
}

/** The console summary: the report, teardown, and where every file is. */
export function printSummary(writer: Writer, finished: Finished, input: ReportInput): void {
	const { result, outDir } = finished
	const at = (name: string): string => resolve(outDir, name)
	writer.out(renderConsole(input))
	for (const line of renderTeardown(result.teardown, result.created)) writer.out(`${line}\n`)
	writer.out(`  confidence: ${at("report.html")}\n`)
	writer.out(`  report: ${at("oat-report.md")}\n`)
	writer.out(`  matrix: ${at("matrix.html")}\n`)
	writer.out(`  graph:  ${at("matrix.json")}\n`)
	if (junitAsked(finished)) writer.out(`  junit: ${at("junit.xml")}\n`)
	writer.out(`  progress: ${at("progress.log")} · ${at("progress.jsonl")}\n`)
	if (result.exchanges !== undefined) writer.out(`  exchanges: ${result.exchanges.count} → ${at("exchanges")}\n`)
	if (result.network?.incomplete === true) writer.out(`  network: ${result.network.kind} — run incomplete\n`)
}
