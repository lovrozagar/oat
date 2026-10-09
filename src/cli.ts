#!/usr/bin/env node
import { EXIT, exitCode } from "./runtime/exit.ts"
import { createWriteStream, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { OatConfig } from "./config/define-config.ts"
import { interpolate, loadConfig } from "./config/load.ts"
import { configProblems } from "./config/validate.ts"
import { report } from "./report/console.ts"
import { renderMatrixGraph, renderMatrixHtml } from "./report/matrix.ts"
import { ISSUE_REPRO_DIR, renderConsole, renderJson, renderMarkdown, renderRepros } from "./report/render.ts"
import {
	createProgressPump,
	createStderrProgress,
	formatProgressJsonl,
	formatProgressLine,
	formatProgressTsv,
	PROGRESS_GLOSSARY,
	PROGRESS_TSV_HEADER,
} from "./runtime/progress.ts"
import { resolveSaveExchanges } from "./runtime/exchanges.ts"
import { allocateRunDir, DEFAULT_RUNS_ROOT, publishLatest } from "./runtime/runs.ts"
import { authStepOperationIds, planScope, resolveTargetScope, ScopeError } from "./runtime/scope.ts"
import { renderTeardown } from "./runtime/teardown.ts"
import { buildModel } from "./spec/graph.ts"
import { dereference, loadSpec } from "./spec/load.ts"

interface Args {
	command: string
	flags: Record<string, string | true>
}

type FlagKind = "boolean" | "value" | "optional-value"

interface FlagSpec {
	kind: FlagKind
	/** A value that must parse as a number of this kind. */
	number?: "integer" | "positive"
}

/** Every flag, once: whether it takes a value, and what kind. Parsing and help both read this. */
export const FLAGS: Readonly<Record<string, FlagSpec>> = {
	backend: { kind: "value" },
	"base-url": { kind: "value" },
	config: { kind: "value" },
	defects: { kind: "value" },
	dialect: { kind: "value" },
	fuzz: { kind: "optional-value", number: "positive" },
	"fuzz-seed": { kind: "value", number: "positive" },
	help: { kind: "boolean" },
	jobs: { kind: "value", number: "positive" },
	json: { kind: "boolean" },
	"keep-fixtures": { kind: "boolean" },
	"max-defects": { kind: "value", number: "positive" },
	"max-in-flight": { kind: "value", number: "positive" },
	"no-save-exchanges": { kind: "boolean" },
	only: { kind: "value" },
	ops: { kind: "value" },
	out: { kind: "value" },
	parser: { kind: "boolean" },
	precision: { kind: "optional-value", number: "positive" },
	profile: { kind: "value" },
	quiet: { kind: "boolean" },
	"save-exchanges": { kind: "boolean" },
	seed: { kind: "value", number: "integer" },
	"skip-backend": { kind: "value" },
	spec: { kind: "value" },
	untagged: { kind: "boolean" },
}

export const KNOWN_FLAGS: ReadonlySet<string> = new Set(Object.keys(FLAGS))

/**
 * `oat <command> [--flag value | --flag=value | --switch] …`. A value flag must have its value;
 * a switch takes none; a numeric value must be one. The first problem is returned as `error`
 * rather than guessed around: `--max-in-flight -1` once hung a run, `--seed abc` seeded strings
 * with `NaN`, and a flag followed by another flag silently became `true`.
 */
export function parseArgs(argv: string[]): Args & { error?: string } {
	const leadingFlag = argv[0]?.startsWith("--") === true
	const command = leadingFlag ? "help" : (argv[0] ?? "help")
	const rest = leadingFlag ? argv : argv.slice(1)
	const flags: Record<string, string | true> = {}
	let error: string | undefined
	const fail = (message: string): void => {
		error ??= message
	}
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]
		if (token === undefined || !token.startsWith("--")) continue
		const equals = token.indexOf("=")
		const key = equals === -1 ? token.slice(2) : token.slice(2, equals)
		const inline = equals === -1 ? undefined : token.slice(equals + 1)
		const spec = FLAGS[key]
		const next = rest[i + 1]
		const nextIsValue = next !== undefined && !next.startsWith("--")
		let value: string | true
		if (spec === undefined || spec.kind === "boolean") {
			if (inline !== undefined && spec !== undefined) fail(`--${key} takes no value`)
			value = inline ?? true
		} else if (inline !== undefined) {
			value = inline
		} else if (nextIsValue) {
			value = next
			i++
		} else if (spec.kind === "optional-value") {
			value = true
		} else {
			fail(`--${key} needs a value`)
			value = true
		}
		if (spec?.number !== undefined && typeof value === "string") {
			const parsed = Number(value)
			const integer = value.trim() !== "" && Number.isSafeInteger(parsed)
			if (!integer || (spec.number === "positive" && parsed < 1)) {
				fail(`--${key} must be ${spec.number === "positive" ? "a positive" : "an"} integer, got "${value}"`)
			}
		}
		flags[key] = value
	}
	return error === undefined ? { command, flags } : { command, error, flags }
}

export function unknownFlag(flags: Record<string, string | true>): string | undefined {
	for (const key of Object.keys(flags)) {
		if (!KNOWN_FLAGS.has(key)) return key
	}
	return undefined
}

export const USAGE = `oat — OpenAPI Tester

  oat run     --config <file>              test a live backend and write a report
  oat plan    --spec <url|file>            derive and print the test model (offline)
  oat doctor  --spec <url|file>            report what oat can and cannot test, and why
  oat serve   [--defects A,B]              run a demo API to point oat at
  oat conformance                          self-test: injected defects vs detection

Flags
  --config     oat config module (.ts/.js/.mjs/.json) with a default export
  --spec       OpenAPI document, http(s) URL or filesystem path
  --base-url   backend under test, overriding the config
  --ops        comma-separated operationIds to grade (row.*, cdn:asset.get); the rest is support
  --only       comma-separated entity names; each grades every operation it owns
  --profile    named profile gating which operations run (built-in: full, cheap)
  --seed       integer seed for fixture generation (default 1)
  --out        history root; each run is <out>/<datetime>/ (default ./.oat/runs)
  --keep-fixtures  leave created records in place instead of tearing them down
  --max-in-flight  requests allowed in flight at once (default 4)
  --quiet          no live progress on stderr (progress.log still written)
  --save-exchanges     persist every HTTP exchange under the run dir (default unless --profile cheap)
  --no-save-exchanges  skip the exchange journal (cheap CI)
  --untagged       serve (or test) a document with every x-* tag stripped
  --backend        conformance storage: memory | sqlite | postgres | d1
                   (default: all local; d1 is remote and opt-in)
  --dialect        API shape: postgrest | classic | linked | jsonapi | plain (default: all)
  --fuzz [n]       inject random defect *combinations* instead of one at a time
  --precision [n]  vary cohort data against a correct backend; any finding is a false positive
  --max-defects    most defects per combination (default: 4)
  --seed           fuzz seed, so a failing combination replays exactly
  --fuzz-seed      seed for the combination smoke pass of a full conformance run (default: 1)
  --jobs           conformance legs run at once, each on its own thread (default: CPUs − 1, at most 4)
  --skip-backend   comma-separated backends a full conformance run may leave out when unreachable
  --json       machine-readable output, for plan and doctor
`

function str(flags: Args["flags"], key: string): string | undefined {
	const value = flags[key]
	return typeof value === "string" ? value : undefined
}

function list(flags: Args["flags"], key: string): string[] | undefined {
	return str(flags, key)
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
}

/**
 * A config file, loaded, checked and interpolated — or the first reason it cannot be used. Every
 * one of these is the caller's to fix, so the command exits 2 with nothing sent.
 */
async function readConfig(path: string, forRun: boolean): Promise<{ config: OatConfig } | { problem: string }> {
	let loaded: OatConfig
	try {
		loaded = await loadConfig(path)
	} catch (error) {
		return { problem: (error instanceof Error ? error.message : String(error)).replace(/^oat: /, "") }
	}
	const problems = configProblems(loaded, { forRun })
	if (problems.length > 0) return { problem: `${path} is not a valid config:\n  ${problems.join("\n  ")}` }
	try {
		return { config: interpolate(loaded) }
	} catch (error) {
		return { problem: (error instanceof Error ? error.message : String(error)).replace(/^oat: /, "") }
	}
}

export { EXIT, exitCode } from "./runtime/exit.ts"

async function commandRun(flags: Args["flags"]): Promise<number> {
	const configPath = str(flags, "config")
	if (configPath === undefined) {
		process.stderr.write("oat: run requires --config\n\n" + USAGE)
		return 2
	}

	const { run } = await import("./runtime/run.ts")
	const read = await readConfig(configPath, true)
	if ("problem" in read) {
		process.stderr.write(`oat: ${read.problem}\n`)
		return EXIT.usage
	}
	const config = read.config
	const baseUrl = str(flags, "base-url") ?? config.baseUrl
	const seedFlag = str(flags, "seed")
	const only = list(flags, "only") ?? config.only?.filter((name) => name.trim() !== "")
	const ops = list(flags, "ops") ?? config.ops?.filter((name) => name.trim() !== "")
	const profile = str(flags, "profile") ?? config.profile
	const saveExchanges = resolveSaveExchanges({
		...(flags["no-save-exchanges"] === true ? { flag: false } : flags["save-exchanges"] === true ? { flag: true } : {}),
		...(config.saveExchanges === undefined ? {} : { config: config.saveExchanges }),
		...(profile === undefined ? {} : { profile }),
	})

	/* No cast: the config's principal type *is* the runtime's, so a mistake here is a compile
	 * error in the user's own config rather than a surprise mid-run. */
	const principals = config.principals ?? []
	if (principals.length === 0) {
		process.stderr.write(
			"oat: config declares no principals. At least one is required so oat can authenticate; " +
				"a second in a different tenant enables the isolation checks.\n",
		)
		return 2
	}

	const startedAt = new Date()
	const began = performance.now()
	const allocated = await allocateRunDir(str(flags, "out") ?? config.outDir ?? DEFAULT_RUNS_ROOT, startedAt)
	const outDir = allocated.runDir
	const stderrProgress = flags.quiet === true ? undefined : createStderrProgress(startedAt.getTime())
	const progressLog = createWriteStream(resolve(outDir, "progress.log"))
	const progressTsv = createWriteStream(resolve(outDir, "progress.tsv"))
	const progressJsonl = createWriteStream(resolve(outDir, "progress.jsonl"))
	progressLog.write(`${PROGRESS_GLOSSARY}\n`)
	progressTsv.write(`${PROGRESS_TSV_HEADER}\n`)
	let lastJsonAt = 0
	const fileProgress = createProgressPump(startedAt.getTime(), (snap, now) => {
		progressLog.write(`${formatProgressLine(snap, now)}\n`)
		progressTsv.write(`${formatProgressTsv(snap, now)}\n`)
		progressJsonl.write(`${formatProgressJsonl(snap, now)}\n`)
		if (now - lastJsonAt >= 1_000 || snap.phase === "done") {
			lastJsonAt = now
			const ageFrom =
				snap.inflight !== undefined ? snap.inflight.at : snap.last !== undefined ? snap.last.at : undefined
			const payload = {
				...snap,
				lastAgoMs: ageFrom === undefined ? null : now - ageFrom,
				updatedAt: new Date(now).toISOString(),
			}
			writeFileSync(resolve(outDir, "progress.json"), `${JSON.stringify(payload, null, 2)}\n`)
		}
	})
	const onProgress = (snap: Parameters<typeof formatProgressLine>[0]): void => {
		stderrProgress?.emit(snap)
		fileProgress.emit(snap)
	}

	/* Ctrl-C stops testing, not the run: what oat created is still removed and the partial report
	 * is still written. A second signal means "now", and exits without either. */
	const stop = new AbortController()
	const onSignal = (signal: NodeJS.Signals): void => {
		if (stop.signal.aborted) {
			process.stderr.write(`\noat: ${signal} again — exiting without teardown\n`)
			process.exit(130)
		}
		process.stderr.write(`\noat: ${signal} — stopping, removing what this run created (again to exit now)\n`)
		stop.abort()
	}
	process.on("SIGINT", onSignal)
	process.on("SIGTERM", onSignal)

	let result: Awaited<ReturnType<typeof run>>
	try {
		result = await run({
			signal: stop.signal,
			baseUrl,
			principals,
			spec: config.spec,
			configDir: dirname(resolve(configPath)),
			...(config.globalHeaders === undefined ? {} : { globalHeaders: config.globalHeaders }),
			...(config.hooks === undefined ? {} : { hooks: config.hooks }),
			...(config.uploads === undefined ? {} : { uploads: config.uploads }),
			...(config.roots === undefined ? {} : { roots: config.roots }),
			...(config.cohortSize === undefined ? {} : { cohortSize: config.cohortSize }),
			...(only === undefined || only.length === 0 ? {} : { only }),
			...(ops === undefined || ops.length === 0 ? {} : { ops }),
			...(profile === undefined ? {} : { profile }),
			...(config.profiles === undefined ? {} : { profiles: config.profiles }),
			...(config.rateLimits === undefined ? {} : { rateLimits: config.rateLimits }),
			...(config.origins === undefined ? {} : { origins: config.origins }),
			...(config.outOfBand === undefined ? {} : { outOfBand: config.outOfBand }),
			...(config.payloads === undefined ? {} : { payloads: config.payloads }),
			...(config.query === undefined ? {} : { query: config.query }),
			...(config.entities === undefined ? {} : { entities: config.entities }),
			keepFixtures: flags["keep-fixtures"] === true || config.keepFixtures === true,
			maxInFlight: Number.parseInt(str(flags, "max-in-flight") ?? "", 10) || config.maxInFlight || 4,
			seed: seedFlag === undefined ? (config.seed ?? 1) : Number.parseInt(seedFlag, 10),
			onProgress,
			...(saveExchanges ? { exchangeDir: outDir } : {}),
			...(config.network === undefined ? {} : { network: config.network }),
		})
	} catch (error) {
		if (!(error instanceof ScopeError)) throw error
		process.stderr.write(`${error.message}\n`)
		return 2
	} finally {
		process.off("SIGINT", onSignal)
		process.off("SIGTERM", onSignal)
		stderrProgress?.stop()
		fileProgress.stop()
		progressLog.end()
		progressTsv.end()
		progressJsonl.end()
	}
	const durationMs = performance.now() - began

	const input = {
		baseUrl,
		checkNotes: result.checkNotes,
		checkTimings: result.checkTimings,
		checksOutOfScope: result.checksOutOfScope,
		checksRun: result.checksRun,
		checksSkipped: result.checksSkipped,
		checksSuppressed: result.checksSuppressed,
		inconclusive: result.inconclusive,
		client: result.client,
		durationMs,
		entitiesTested: result.entitiesTested,
		findings: result.findings,
		model: result.model,
		profile: result.profile,
		profileExclusions: result.profileExclusions,
		scope: result.scope,
		startedAt,
		...(result.exchanges === undefined ? {} : { exchanges: result.exchanges }),
		...(result.network === undefined ? {} : { network: result.network }),
	}

	await writeFile(resolve(outDir, "principals.json"), `${JSON.stringify({ principals: result.principals }, null, 2)}\n`)
	await writeFile(resolve(outDir, "oat-report.md"), renderMarkdown(input))
	await writeFile(resolve(outDir, "oat-report.json"), renderJson(input))
	await writeFile(resolve(outDir, "matrix.html"), renderMatrixHtml(input))
	await writeFile(resolve(outDir, "matrix.json"), renderMatrixGraph(input))
	const scripts = renderRepros(result.findings, baseUrl)
	if (scripts.length > 0) {
		const dir = resolve(outDir, ISSUE_REPRO_DIR)
		await mkdir(dir, { recursive: true })
		for (const script of scripts) {
			await writeFile(resolve(dir, script.filename), script.content, { mode: 0o755 })
		}
	}

	process.stdout.write(renderConsole(input))
	for (const line of renderTeardown(result.teardown ?? { failed: [], removed: 0, unsupported: [] }, result.created)) {
		process.stdout.write(`${line}\n`)
	}
	process.stdout.write(`  report: ${resolve(outDir, "oat-report.md")}\n`)
	process.stdout.write(`  matrix: ${resolve(outDir, "matrix.html")}\n`)
	process.stdout.write(`  graph:  ${resolve(outDir, "matrix.json")}\n`)
	process.stdout.write(`  progress: ${resolve(outDir, "progress.log")} · ${resolve(outDir, "progress.jsonl")}\n`)
	if (result.exchanges !== undefined) {
		process.stdout.write(`  exchanges: ${result.exchanges.count} → ${resolve(outDir, "exchanges")}\n`)
	}
	if (result.network?.incomplete === true) {
		process.stdout.write(`  network: ${result.network.kind} — run incomplete\n`)
	}
	await publishLatest(allocated)
	process.stdout.write(`  latest: ${allocated.latest}\n\n`)

	return exitCode(result)
}

export async function main(): Promise<number> {
	const { command, error: flagError, flags } = parseArgs(process.argv.slice(2))

	const unknown = unknownFlag(flags)
	if (unknown !== undefined) {
		process.stderr.write(`oat: unknown flag "--${unknown}"\n\n${USAGE}`)
		return 2
	}
	if (flagError !== undefined) {
		process.stderr.write(`oat: ${flagError}\n\n${USAGE}`)
		return EXIT.usage
	}

	if (command === "help" || flags.help === true) {
		process.stdout.write(USAGE)
		return 0
	}

	if (command === "conformance") {
		const {
			postgresAvailable,
			renderParserSuite,
			renderUnproven,
			runExampleSpecSuite,
			runTagUnlockSuite,
			runParserSuite,
			runPayloadCatalogSuite,
			runCoverageReportSuite,
			runSeedContractSuite,
			runEffectsSuite,
			runTenantScopeSuite,
			sqliteAvailable,
			d1Available,
		} = await import("./conformance/suite.ts")
		/* A typo in a selector must stop the run, not widen it: an unknown backend once ran every
		 * backend, and an unknown dialect silently filtered out the defects it could not express. */
		const { DIALECTS } = await import("./reference/dialect.ts")
		const { isDefectName } = await import("./reference/defects.ts")
		const backendFlag = str(flags, "backend")
		const backendNames = ["memory", "sqlite", "postgres", "d1"]
		if (backendFlag !== undefined && !backendNames.includes(backendFlag)) {
			process.stderr.write(`oat: unknown --backend "${backendFlag}" — expected ${backendNames.join(", ")}\n`)
			return 2
		}
		const dialectFlag = str(flags, "dialect")
		if (dialectFlag !== undefined && !Object.hasOwn(DIALECTS, dialectFlag)) {
			process.stderr.write(`oat: unknown --dialect "${dialectFlag}" — expected ${Object.keys(DIALECTS).join(", ")}\n`)
			return 2
		}
		const onlyFlag = str(flags, "only")?.split(",").filter(Boolean)
		const unknownDefects = (onlyFlag ?? []).filter((name) => !isDefectName(name))
		if (flags.only === true || (onlyFlag !== undefined && onlyFlag.length === 0)) {
			process.stderr.write("oat: --only needs a comma-separated list of defect names\n")
			return 2
		}
		if (unknownDefects.length > 0) {
			process.stderr.write(`oat: --only names no defect: ${unknownDefects.join(", ")}\n`)
			return 2
		}
		const { createPool, defaultJobs } = await import("./conformance/pool.ts")
		const { runFeatureGateSuite } = await import("./conformance/feature-gate.ts")
		const { runRateLimitSuite } = await import("./conformance/rate-limit.ts")
		const { runUniqueSuite } = await import("./conformance/unique.ts")
		const parser = renderParserSuite(runParserSuite())
		process.stdout.write(parser.text)
		/* The documented example is checked in the same breath: it is the only place a reader
		 * sees where each tag goes, and documentation that drifts teaches a shape that no longer
		 * works. */
		const example = renderParserSuite(await runExampleSpecSuite())
		process.stdout.write(example.text)
		parser.failures += example.failures
		/* The defect matrix makes the two runs the tag-unlock claims are judged from; only a run
		 * that stops before the matrix makes them here. */
		const beforeMatrix = flags.parser === true || flags.precision !== undefined || flags.fuzz !== undefined
		if (beforeMatrix) {
			const unlocks = renderParserSuite(await runTagUnlockSuite())
			process.stdout.write(unlocks.text)
			parser.failures += unlocks.failures
		}
		const coverage = renderParserSuite(runCoverageReportSuite())
		process.stdout.write(coverage.text)
		parser.failures += coverage.failures
		const tenant = renderParserSuite(await runTenantScopeSuite())
		process.stdout.write(tenant.text)
		parser.failures += tenant.failures
		const featureGate = renderParserSuite(await runFeatureGateSuite())
		process.stdout.write(featureGate.text)
		parser.failures += featureGate.failures
		const rateLimit = renderParserSuite(await runRateLimitSuite())
		process.stdout.write(rateLimit.text)
		parser.failures += rateLimit.failures
		const unique = renderParserSuite(await runUniqueSuite())
		process.stdout.write(unique.text)
		parser.failures += unique.failures
		const seedContract = renderParserSuite(await runSeedContractSuite())
		process.stdout.write(seedContract.text)
		parser.failures += seedContract.failures
		const effects = renderParserSuite(await runEffectsSuite())
		process.stdout.write(effects.text)
		parser.failures += effects.failures
		const payloads = renderParserSuite(runPayloadCatalogSuite())
		process.stdout.write(payloads.text)
		parser.failures += payloads.failures
		if (flags.parser === true) return parser.failures > 0 ? 1 : 0

		if (flags.precision !== undefined) {
			/* Varies the data rather than the faults, against a backend with nothing wrong with it.
			 * Any finding here is a false positive by construction. */
			const { renderPrecision, runPrecision } = await import("./conformance/fuzz.ts")
			const n = typeof flags.precision === "string" ? Number.parseInt(flags.precision, 10) : 50
			const rendered = renderPrecision(
				await runPrecision({
					backend: (str(flags, "backend") ?? "memory") as "memory" | "sqlite" | "postgres",
					cases: Number.isFinite(n) && n > 0 ? n : 50,
					dialect: str(flags, "dialect") ?? "postgrest",
					seed: Number.parseInt(str(flags, "seed") ?? "1", 10) || 1,
				}),
			)
			process.stdout.write(rendered.text)
			return parser.failures + rendered.failures > 0 ? 1 : 0
		}

		if (flags.fuzz !== undefined) {
			/* Combination fuzzing is its own question — whether the diagnosis survives several
			 * simultaneous faults — so it replaces the matrix rather than padding it. */
			const { renderFuzz, runFuzz } = await import("./conformance/fuzz.ts")
			const count = typeof flags.fuzz === "string" ? Number.parseInt(flags.fuzz, 10) : 25
			const fuzzBackend = str(flags, "backend")
			const results = await runFuzz({
				backend: (fuzzBackend ?? "memory") as "memory" | "sqlite" | "postgres",
				cases: Number.isFinite(count) && count > 0 ? count : 25,
				dialect: str(flags, "dialect") ?? "postgrest",
				maxDefects: Number.parseInt(str(flags, "max-defects") ?? "4", 10) || 4,
				seed: Number.parseInt(str(flags, "seed") ?? "1", 10) || 1,
			})
			const rendered = renderFuzz(results)
			process.stdout.write(rendered.text)
			return parser.failures + rendered.failures > 0 ? 1 : 0
		}

		const only = str(flags, "only")?.split(",")
		const requested = str(flags, "backend")
		/* Both by default. A check that passes against the in-memory store but not against real
		 * SQL was relying on JavaScript semantics — NULL ordering, collation, LIKE escaping — that
		 * a database does not share, and running only one backend hides exactly that. */
		const all = ["memory", "sqlite", "postgres", "d1"] as const
		type BackendName = (typeof all)[number]
		const available: BackendName[] = ["memory"]
		if (await sqliteAvailable()) available.push("sqlite")
		if (await postgresAvailable()) available.push("postgres")
		/* Present but never default: D1 is remote, so a pass costs minutes and consumes someone's
		 * quota. It runs when asked for by name. */
		const d1Ready = d1Available()

		const backends: BackendName[] = all.includes(requested as BackendName) ? [requested as BackendName] : available

		const skipped = all.filter((b) => b !== "d1" && !available.includes(b))

		const dialect = str(flags, "dialect")
		/* Backends vary the storage engine; dialects vary the API's conventions. Running the full
		 * cross product would be mostly redundant, so every backend is exercised on the default
		 * dialect and one extra pass covers a second dialect that shares no parameter names. */
		const passes: Array<{ backend: BackendName; dialect: string }> =
			dialect === undefined && requested === undefined
				? [
						...backends.map((backend) => ({ backend, dialect: "postgrest" })),
						/* Two extra shapes on the cheapest backend. `classic` renames everything;
						 * `linked` changes the pagination *model* — root array, Link header, row
						 * offsets — which is the stronger test of whether checks read the document
						 * or the fixture's habits. */
						{ backend: "memory" as const, dialect: "classic" },
						{ backend: "memory" as const, dialect: "linked" },
						{ backend: "memory" as const, dialect: "jsonapi" },
						{ backend: "memory" as const, dialect: "plain" },
					]
				: backends.map((backend) => ({ backend, dialect: dialect ?? "postgrest" }))

		let failures = parser.failures
		const proven = new Set<string>()
		const jobsFlag = str(flags, "jobs")
		const jobs = jobsFlag === undefined ? defaultJobs() : Number.parseInt(jobsFlag, 10)
		if (!Number.isSafeInteger(jobs) || jobs < 1) {
			process.stderr.write("oat: --jobs must be a positive integer\n")
			return 2
		}
		/* Every leg is queued at once and printed in order as its turn comes. */
		const pool = createPool(jobs)
		const withShapes = requested === undefined || requested === "memory"
		const passAnswers = passes.map((pass) =>
			pool.run({ backend: pass.backend, dialect: pass.dialect, kind: "pass", ...(only === undefined ? {} : { only }) }),
		)
		const shapeAnswer = withShapes ? pool.run({ kind: "shapes" }) : undefined
		/* `--ops` recall needs each defect's full run, which the default pass has just made; only
		 * the targeted half is sent, spread across the pool. */
		const fullRun = only === undefined && requested === undefined && dialect === undefined
		const defaultPass = passes.findIndex((pass) => pass.backend === "memory" && pass.dialect === "postgrest")
		const scopeAnswers =
			!fullRun || defaultPass === -1
				? undefined
				: passAnswers[defaultPass]?.then(async (answer) => {
						const { DEFECTS } = await import("./reference/defects.ts")
						const names = Object.keys(DEFECTS)
						const known = answer.kind === "pass" ? answer.primaryOps : {}
						const chunks = Array.from({ length: jobs }, (_, lane) =>
							names.filter((_name, index) => index % jobs === lane),
						).filter((chunk) => chunk.length > 0)
						return Promise.all(chunks.map((defects) => pool.run({ defects, kind: "scope", known })))
					})
		const recallAnswers =
			shapeAnswer === undefined || only !== undefined
				? undefined
				: shapeAnswer.then((answer) =>
						Promise.all(
							(answer.kind === "cases" ? answer.cases : []).map((shape) =>
								pool.run({ kind: "recall", shapes: [shape] }),
							),
						),
					)
		try {
			for (const [index, pass] of passes.entries()) {
				process.stdout.write(`\n  ── ${pass.backend} · ${pass.dialect} ${"─".repeat(46)}\n`)
				const result = await passAnswers[index]
				if (result?.kind !== "pass") continue
				process.stdout.write(result.text)
				failures += result.failures
				for (const id of result.proven) proven.add(id)
			}
			/* Only a complete run can say a check was never proven; a filtered one never tried. */
			if (fullRun) {
				const unproven = renderUnproven(proven)
				process.stdout.write(unproven.text)
				failures += unproven.failures
			}
			const defaultAnswer = defaultPass === -1 ? undefined : await passAnswers[defaultPass]
			const unlocks = renderParserSuite(
				await runTagUnlockSuite(defaultAnswer?.kind === "pass" ? defaultAnswer.baselines : undefined),
			)
			process.stdout.write(unlocks.text)
			failures += unlocks.failures
			if (scopeAnswers !== undefined) {
				const scopeResults = (await scopeAnswers).flatMap((answer) => (answer.kind === "results" ? answer.results : []))
				const scope = renderParserSuite(scopeResults)
				process.stdout.write(scope.text)
				failures += scope.failures
			}
			/* The opposite question to the defect matrix: whether oat stays quiet on a correct backend
			 * shaped unlike the one it was written against. One engine is enough — a shape varies the
			 * API, not the storage. */
			if (shapeAnswer !== undefined) {
				const { renderShapeSuite } = await import("./conformance/shapes.ts")
				process.stdout.write(`\n  ── shapes · memory ${"─".repeat(46)}\n`)
				const shapeCases = await shapeAnswer
				const shapes = renderShapeSuite(shapeCases.kind === "cases" ? shapeCases.cases : [])
				process.stdout.write(shapes.text)
				failures += shapes.failures
				if (recallAnswers !== undefined) {
					process.stdout.write(`\n  ── recall behind shapes · memory ${"─".repeat(32)}\n`)
					const recallCases = (await recallAnswers).flatMap((answer) => (answer.kind === "cases" ? answer.cases : []))
					const recall = renderShapeSuite(recallCases, true)
					process.stdout.write(recall.text)
					failures += recall.failures
				}
			}
		} finally {
			await pool.close()
		}
		if (requested === undefined && skipped.length > 0) {
			/* An engine that is not there is not a pass: the SQL-only defects and every engine
			 * difference go untested. Leaving one out has to be asked for by name. */
			const allowed = new Set(str(flags, "skip-backend")?.split(",") ?? [])
			for (const backend of skipped) {
				const why =
					backend === "sqlite"
						? "node:sqlite unavailable (Node 22 needs --experimental-sqlite)"
						: "no Postgres server reachable on the default connection"
				if (allowed.has(backend)) {
					process.stdout.write(`  note: ${backend} backend skipped as asked — ${why}\n`)
				} else {
					failures += 1
					process.stdout.write(
						`  ✗ ${backend} backend unavailable — ${why}. Start it, or pass --skip-backend ${backend}\n`,
					)
				}
			}
			process.stdout.write("\n")
		}
		if (requested === undefined && only === undefined) {
			/* A short combination pass runs as part of the standard self-test. Single-defect recall
			 * says nothing about how the diagnosis holds up when several faults overlap, and every
			 * bug the fuzzer has found so far — silent bail-outs, non-transitive suppression, a
			 * probe writing into a constrained field — was invisible to the one-at-a-time matrix. */
			const { renderFuzz, runFuzz } = await import("./conformance/fuzz.ts")
			process.stdout.write(`\n  ── combinations ${"─".repeat(46)}\n`)
			/* A fixed seed tests the same 40 combinations forever. CI passes a fresh one per run and
			 * the seed is printed, so any failure it finds replays exactly. */
			const fuzzSeed = Number.parseInt(str(flags, "fuzz-seed") ?? "1", 10)
			if (!Number.isSafeInteger(fuzzSeed) || fuzzSeed < 1) {
				process.stderr.write("oat: --fuzz-seed must be a positive integer\n")
				return 2
			}
			process.stdout.write(`  fuzz seed ${fuzzSeed} — replay with --fuzz 40 --max-defects 6 --seed ${fuzzSeed}\n`)
			const smoke = renderFuzz(await runFuzz({ backend: "memory", cases: 40, maxDefects: 6, seed: fuzzSeed }))
			process.stdout.write(smoke.text)
			failures += smoke.failures
		}

		if (requested === undefined) {
			process.stdout.write(
				d1Ready
					? "  note: d1 backend available — run with --backend d1 (remote, ~2min per defect)\n\n"
					: "  note: d1 backend needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN\n\n",
			)
		}
		return failures > 0 ? 1 : 0
	}

	if (command === "serve") {
		/* A built-in demo API so oat can be tried before wiring it to anything real. The
		 * reference backend doubles as the conformance fixture, so this is the same server the
		 * self-test runs against. */
		const backend = str(flags, "backend") ?? "memory"
		const defects = str(flags, "defects")?.split(",").filter(Boolean) ?? []
		const { createMemoryServer, createPostgresServer, createSqliteServer } = await import("./reference/http.ts")
		const factory =
			backend === "sqlite" ? createSqliteServer : backend === "postgres" ? createPostgresServer : createMemoryServer
		/* `--untagged` serves the same API behind a document stripped of every x-* tag, which is
		 * what `oat doctor` should be pointed at to see what a plain OpenAPI document costs. */
		const untagged = flags.untagged === true
		const dialect = str(flags, "dialect")
		const server = await factory({
			defects,
			untagged,
			...(dialect === undefined ? {} : { dialect }),
		})
		process.stdout.write(
			`\n  oat demo API — ${backend}${untagged ? " (untagged spec)" : ""}\n` +
				`  url      ${server.url}\n` +
				`  spec     ${server.url}/v1/openapi/spec\n` +
				`  dialect  ${dialect ?? "postgrest"}\n` +
				`  defects  ${defects.length > 0 ? defects.join(", ") : "none — a correct backend"}\n` +
				`  keys     key_alpha (proj_alpha) · key_beta (proj_beta)\n\n` +
				"  point a config at it:\n" +
				`    oat run --config labs/local.config.ts --base-url ${server.url}\n\n` +
				"  ctrl-c to stop\n\n",
		)
		/* Node buffers stdout when it is not a TTY, so a piped `oat serve` would print nothing
		 * until exit — indistinguishable from a hang. */
		if (typeof process.stdout.write === "function") process.stdout.uncork?.()

		/* Resolves only on signal — the process should stay up serving. */
		await new Promise<void>((resolve) => {
			process.on("SIGINT", () => resolve())
			process.on("SIGTERM", () => resolve())
		})
		await server.close()
		return 0
	}

	if (command === "run") return commandRun(flags)

	const specFlag = str(flags, "spec")
	const configPath = str(flags, "config")
	const read = configPath === undefined ? undefined : await readConfig(configPath, false)
	if (read !== undefined && "problem" in read) {
		process.stderr.write(`oat: ${read.problem}\n`)
		return EXIT.usage
	}
	const loaded = read?.config
	const specSource = specFlag ?? loaded?.spec

	if (specSource === undefined) {
		process.stderr.write("oat: --spec (or --config) is required\n\n" + USAGE)
		return 2
	}

	/* A relative spec resolves against the config's base URL, as it does for `run`. */
	const raw = await loadSpec(specSource, str(flags, "base-url") ?? loaded?.baseUrl)
	const { doc, externalRefs } = dereference(raw)
	const model = buildModel(doc)
	try {
		const { probeCreateFixtures } = await import("./runtime/world.ts")
		probeCreateFixtures(model)
	} catch (error) {
		const { isOverflowError } = await import("./runtime/fixture.ts")
		if (!isOverflowError(error)) throw error
	}

	switch (command) {
		case "plan": {
			const ops = list(flags, "ops") ?? loaded?.ops
			const only = list(flags, "only") ?? loaded?.only
			let scope: ReturnType<typeof planScope> | undefined
			try {
				scope = planScope(
					model,
					resolveTargetScope(model, {
						...(ops === undefined ? {} : { ops }),
						...(only === undefined ? {} : { only }),
						authCreates: authStepOperationIds(loaded?.principals ?? []),
					}),
				)
			} catch (error) {
				if (!(error instanceof ScopeError)) throw error
				process.stderr.write(`${error.message}\n`)
				return 2
			}
			process.stdout.write(report.plan(model, flags.json === true, scope.mode === "targeted" ? scope : undefined))
			return 0
		}
		case "doctor": {
			const config = loaded
			const output = report.doctor(
				model,
				externalRefs,
				flags.json === true,
				config === undefined
					? undefined
					: {
							...(config.query === undefined ? {} : { query: config.query }),
							...(config.entities === undefined ? {} : { entities: config.entities }),
							...(config.hooks === undefined ? {} : { hooks: config.hooks }),
						},
			)
			process.stdout.write(output.text)
			return output.blocking > 0 ? 1 : 0
		}
		default:
			process.stderr.write(`oat: unknown command "${command}"\n\n${USAGE}`)
			return 2
	}
}

export function start(): void {
	main().then(
		(code) => {
			process.exitCode = code
		},
		(error: unknown) => {
			process.stderr.write(`oat: ${error instanceof Error ? error.message : String(error)}\n`)
			process.exitCode = EXIT.failed
		},
	)
}

/* `node dist/cli.js …` is the test/CI entry. `bin/oat.js` calls start() itself because
 * argv[1] is the bin wrapper, not this module. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	start()
}
