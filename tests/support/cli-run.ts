import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../src/cli/main.ts"
import { bufferWriter } from "../../src/cli/writer.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"

/*
 * `oat` as a user runs it, in process: argv in, the exit code and every line it printed out. A run
 * writes `<out>/<datetime>/` and points `<out>/latest` at it, so a test reads the run it just made
 * through `latest`.
 */

/** One `oat …` invocation: its exit code, and stdout and stderr in the order they were written. */
export async function oat(argv: readonly string[]): Promise<{ code: number; out: string }> {
	const writer = bufferWriter()
	const code = await main(argv, { writer })
	return { code, out: writer.text() }
}

/** A temp folder of a test's own, and how to remove every one it made. */
export function tempDirs(prefix: string): { make: () => Promise<string>; removeAll: () => Promise<void> } {
	const made: string[] = []
	return {
		make: async () => {
			const dir = await mkdtemp(join(tmpdir(), prefix))
			made.push(dir)
			return dir
		},
		removeAll: async () => {
			await Promise.all(made.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
		},
	}
}

/** `oat.config.json` in `dir`, made if missing, for the reference at `url`, with `extra` laid over the defaults. */
export async function referenceConfig(dir: string, url: string, extra: Record<string, unknown> = {}): Promise<string> {
	await mkdir(dir, { recursive: true })
	const path = join(dir, "oat.config.json")
	const config = {
		baseUrl: url,
		principals: PRINCIPALS,
		security: SECURITY,
		seed: 42,
		spec: `${url}/v1/openapi/spec`,
		...extra,
	}
	await writeFile(path, JSON.stringify(config))
	return path
}

/** A finding as `oat-report.json` holds it. */
export interface ReportFinding {
	check: string
	entity: string
	verdict: string
	origin?: string
	operations?: string[]
	known?: { reason: string }
}

/** The fields of `oat-report.json` these tests read. */
export interface SavedRunReport {
	outcome: { exitCode: number; reason: string; result: string }
	findings: ReportFinding[]
	profile: string
	profileExclusions: Array<{ entity: string; operationId: string; reason: string }>
	scope: {
		mode: string
		operations: Array<{
			operationId: string
			entity?: string
			origin?: string
			status: string
			checks: { passed: string[] }
		}>
		originsSkipped: string[]
	}
	/* Absent when the run tore nothing down: `--keep-fixtures`, or nothing was made. */
	teardown?: {
		failed: Array<{ entity: string; id: string; reason: string }>
		records: Array<{ entity: string; id: string; removed: boolean }>
	}
	baseline?: { fixed: Array<{ check: string }> }
}

/** The report of the run `out/latest` points at. */
export async function latestReport(out: string): Promise<SavedRunReport> {
	return JSON.parse(await readFile(join(out, "latest", "oat-report.json"), "utf8")) as SavedRunReport
}

/** One line of a run's `exchanges.jsonl`. */
export interface JournalLine {
	url: string
	method: string
	status: number
	operationId?: string
	phase?: string
}

/** Every exchange the run at `out/latest` journaled, in order. */
export async function latestJournal(out: string): Promise<JournalLine[]> {
	const text = await readFile(join(out, "latest", "exchanges.jsonl"), "utf8")
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as JournalLine)
}
