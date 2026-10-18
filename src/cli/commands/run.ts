import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { OatConfig } from "../../config/types/config.ts"
import { messageOf } from "../../errors/message.ts"
import { UsageError } from "../../errors/usage-error.ts"
import { type BaselineFile, parseBaseline } from "../../runtime/baseline.ts"
import { resolveSaveExchanges } from "../../runtime/exchanges/files.ts"
import { EXIT, exitCode } from "../../runtime/exit.ts"
import { FencedError } from "../../runtime/fence.ts"
import type { RunOptions, RunResult } from "../../runtime/run/index.ts"
import { allocateRunDir, DEFAULT_RUNS_ROOT, publishLatest } from "../../runtime/runs.ts"
import { readConfig } from "../config.ts"
import { type Args, str, USAGE } from "../flags.ts"
import type { Writer } from "../writer.ts"
import { runOptionsOf } from "./run-options.ts"
import { runProgress } from "./run-progress.ts"
import { type Finished, printSummary, reportInput, writeReports } from "./run-report.ts"
import { signalExit, type SignalSource, stopOnSignal } from "./run-signals.ts"

/** What `run` needs from outside: the run itself, and where signals come from. */
export interface RunDeps {
	run(options: RunOptions): Promise<RunResult>
	signals: SignalSource
}

/** Loaded when a run starts, not when the CLI does: `oat help` should not pay for it. */
export async function runPipeline(options: RunOptions): Promise<RunResult> {
	const { run } = await import("../../runtime/run/index.ts")
	return run(options)
}

const PROCESS: RunDeps = { run: runPipeline, signals: process }

/**
 * `oat run --config <file>`: tests the backend the config names, and writes the run folder — the
 * reports, the progress files and, unless asked not to, the exchange journal. The exit code says
 * what the run found.
 */
export async function commandRun(writer: Writer, flags: Args["flags"], deps: RunDeps = PROCESS): Promise<number> {
	const configPath = str(flags, "config")
	if (configPath === undefined) {
		writer.err(`oat: run requires --config\n\n${USAGE}`)
		return EXIT.usage
	}
	const read = await readConfig(configPath, true)
	if ("problem" in read) {
		writer.err(`oat: ${read.problem}\n`)
		return EXIT.usage
	}
	/* The config's checks already refused one without principals: the run has someone to act as. */
	const { config } = read
	const baseline = await baselineOf(config, configPath)
	if (typeof baseline === "string") {
		writer.err(`oat: ${baseline}\n`)
		return EXIT.usage
	}
	return started(writer, { baseline, config, configPath, deps, flags })
}

/** Known findings, relative to the config file like every other path in it — or why they cannot be read. */
async function baselineOf(config: OatConfig, configPath: string): Promise<BaselineFile | undefined | string> {
	if (config.baseline === undefined) return undefined
	const path = resolve(dirname(resolve(configPath)), config.baseline)
	try {
		return parseBaseline(JSON.parse(await readFile(path, "utf8")), path)
	} catch (error) {
		return error instanceof UsageError ? error.message : `cannot read baseline ${path}: ${messageOf(error)}`
	}
}

interface Start {
	config: OatConfig
	configPath: string
	flags: Args["flags"]
	baseline: BaselineFile | undefined
	deps: RunDeps
}

/** The run, from its folder to its exit code. */
async function started(writer: Writer, start: Start): Promise<number> {
	const { config, flags, deps } = start
	const startedAt = new Date()
	const began = performance.now()
	const allocated = await allocateRunDir(str(flags, "out") ?? config.outDir ?? DEFAULT_RUNS_ROOT, startedAt)
	const outDir = allocated.runDir
	const progress = runProgress(writer, outDir, { quiet: flags.quiet === true, startedAt: startedAt.getTime() })
	const stop = stopOnSignal(writer, deps.signals)
	const options = runOptionsOf(config, flags, {
		baseline: start.baseline,
		configPath: start.configPath,
		exchangeDir: savesExchanges(config, flags) ? outDir : undefined,
		onProgress: progress.onProgress,
		signal: stop.signal,
		warn: (message) => writer.err(`oat: ${message}\n`),
	})
	let result: RunResult
	try {
		result = await deps.run(options)
	} catch (error) {
		return refused(writer, error)
	} finally {
		stop.dispose()
		progress.close()
	}
	const finished: Finished = {
		baseUrl: options.baseUrl,
		durationMs: performance.now() - began,
		outDir,
		result,
		startedAt,
	}
	const input = reportInput(finished)
	await writeReports(finished, input)
	printSummary(writer, finished, input)
	await publishLatest(allocated)
	writer.out(`  latest: ${allocated.latest}\n\n`)
	const by = stop.by()
	/* Stopped by a signal: the shell's convention, once teardown and the report are done. */
	return by === undefined ? exitCode(result) : signalExit(by)
}

function savesExchanges(config: OatConfig, flags: Args["flags"]): boolean {
	const profile = str(flags, "profile") ?? config.profile
	return resolveSaveExchanges({
		...(flags["no-save-exchanges"] === true ? { flag: false } : flags["save-exchanges"] === true ? { flag: true } : {}),
		...(config.saveExchanges === undefined ? {} : { config: config.saveExchanges }),
		...(profile === undefined ? {} : { profile }),
	})
}

/** A run refused before it could start — the document, or a principal's sign-in. Anything else is a bug. */
function refused(writer: Writer, error: unknown): number {
	if (error instanceof FencedError) {
		writer.err(`oat: ${error.message}\n`)
		return EXIT.failed
	}
	if (!(error instanceof UsageError)) throw error
	writer.err(`${error.message}\n`)
	return EXIT.usage
}
