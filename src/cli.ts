#!/usr/bin/env node
import { createWriteStream, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { interpolate, loadConfig } from "./config/load.ts"
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
import { allocateRunDir, DEFAULT_RUNS_ROOT } from "./runtime/runs.ts"
import { renderTeardown } from "./runtime/teardown.ts"
import { buildModel } from "./spec/graph.ts"
import { dereference, loadSpec } from "./spec/load.ts"

interface Args {
	command: string
	flags: Record<string, string | true>
}

export const KNOWN_FLAGS = new Set([
	"help",
	"config",
	"spec",
	"base-url",
	"only",
	"profile",
	"seed",
	"out",
	"keep-fixtures",
	"max-in-flight",
	"quiet",
	"untagged",
	"backend",
	"dialect",
	"fuzz",
	"precision",
	"max-defects",
	"json",
	"parser",
	"save-exchanges",
	"no-save-exchanges",
])

export function parseArgs(argv: string[]): Args {
	const [command = "help", ...rest] = argv
	const flags: Record<string, string | true> = {}
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]
		if (token === undefined || !token.startsWith("--")) continue
		const key = token.slice(2)
		const next = rest[i + 1]
		if (next !== undefined && !next.startsWith("--")) {
			flags[key] = next
			i++
		} else {
			flags[key] = true
		}
	}
	return { command, flags }
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
  --only       comma-separated entity names to restrict the run to
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
  --json       machine-readable output, for plan and doctor
`

function str(flags: Args["flags"], key: string): string | undefined {
	const value = flags[key]
	return typeof value === "string" ? value : undefined
}

async function commandRun(flags: Args["flags"]): Promise<number> {
	const configPath = str(flags, "config")
	if (configPath === undefined) {
		process.stderr.write("oat: run requires --config\n\n" + USAGE)
		return 2
	}

	const { run } = await import("./runtime/run.ts")
	const config = interpolate(await loadConfig(configPath))
	const baseUrl = str(flags, "base-url") ?? config.baseUrl
	const seedFlag = str(flags, "seed")
	const onlyFromFlag = str(flags, "only")
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
	const only = onlyFromFlag ?? config.only?.filter((name) => name.trim() !== "")
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

	let result: Awaited<ReturnType<typeof run>>
	try {
		result = await run({
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
			...(profile === undefined ? {} : { profile }),
			...(config.profiles === undefined ? {} : { profiles: config.profiles }),
			...(config.rateLimits === undefined ? {} : { rateLimits: config.rateLimits }),
			...(config.origins === undefined ? {} : { origins: config.origins }),
			...(config.outOfBand === undefined ? {} : { outOfBand: config.outOfBand }),
			...(config.query === undefined ? {} : { query: config.query }),
			...(config.entities === undefined ? {} : { entities: config.entities }),
			keepFixtures: flags["keep-fixtures"] === true || config.keepFixtures === true,
			maxInFlight: Number.parseInt(str(flags, "max-in-flight") ?? "", 10) || config.maxInFlight || 4,
			seed: seedFlag === undefined ? (config.seed ?? 1) : Number.parseInt(seedFlag, 10),
			onProgress,
			...(saveExchanges ? { exchangeDir: outDir } : {}),
			...(config.network === undefined ? {} : { network: config.network }),
		})
	} finally {
		stderrProgress?.stop()
		fileProgress.stop()
		progressLog.end()
		progressTsv.end()
		progressJsonl.end()
	}
	const durationMs = performance.now() - began

	const input = {
		baseUrl,
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
	process.stdout.write(`  latest: ${allocated.latest}\n\n`)

	/* Exit code counts root causes, not raw findings: gaps and blocked entries are information,
	 * not failures, and a CI gate should react to defects only. */
	if (result.network?.incomplete === true) return 1
	return result.findings.filter((f) => f.verdict !== "COVERAGE_GAP" && f.verdict !== "BLOCKED").length > 0 ? 1 : 0
}

export async function main(): Promise<number> {
	const { command, flags } = parseArgs(process.argv.slice(2))

	const unknown = unknownFlag(flags)
	if (unknown !== undefined) {
		process.stderr.write(`oat: unknown flag "--${unknown}"\n\n${USAGE}`)
		return 2
	}

	if (command === "help" || flags.help === true) {
		process.stdout.write(USAGE)
		return 0
	}

	if (command === "conformance") {
		const {
			postgresAvailable,
			renderParserSuite,
			renderSuite,
			runExampleSpecSuite,
			runTagUnlockSuite,
			runParserSuite,
			runPayloadCatalogSuite,
			runCoverageReportSuite,
			runSeedContractSuite,
			runEffectsSuite,
			runTenantScopeSuite,
			runSuite,
			sqliteAvailable,
			d1Available,
		} = await import("./conformance/suite.ts")
		const { runFeatureGateSuite } = await import("./conformance/feature-gate.ts")
		const { runRateLimitSuite } = await import("./conformance/rate-limit.ts")
		const parser = renderParserSuite(runParserSuite())
		process.stdout.write(parser.text)
		/* The documented example is checked in the same breath: it is the only place a reader
		 * sees where each tag goes, and documentation that drifts teaches a shape that no longer
		 * works. */
		const example = renderParserSuite(await runExampleSpecSuite())
		process.stdout.write(example.text)
		parser.failures += example.failures
		const unlocks = renderParserSuite(await runTagUnlockSuite())
		process.stdout.write(unlocks.text)
		parser.failures += unlocks.failures
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
		for (const pass of passes) {
			process.stdout.write(`\n  ── ${pass.backend} · ${pass.dialect} ${"─".repeat(46)}\n`)
			const result = renderSuite(await runSuite(only, pass.backend, pass.dialect), pass.dialect)
			process.stdout.write(result.text)
			failures += result.failures
		}
		if (requested === undefined && skipped.length > 0) {
			for (const backend of skipped) {
				const why =
					backend === "sqlite"
						? "node:sqlite unavailable (Node 22 needs --experimental-sqlite)"
						: "no Postgres server reachable on the default connection"
				process.stdout.write(`  note: ${backend} backend skipped — ${why}\n`)
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
			const smoke = renderFuzz(await runFuzz({ backend: "memory", cases: 40, maxDefects: 6, seed: 1 }))
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
	const specSource = specFlag ?? (configPath === undefined ? undefined : (await loadConfig(configPath)).spec)

	if (specSource === undefined) {
		process.stderr.write("oat: --spec (or --config) is required\n\n" + USAGE)
		return 2
	}

	const raw = await loadSpec(specSource, str(flags, "base-url"))
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
		case "plan":
			process.stdout.write(report.plan(model, flags.json === true))
			return 0
		case "doctor": {
			const config = configPath === undefined ? undefined : interpolate(await loadConfig(configPath))
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
			process.exitCode = 1
		},
	)
}

/* `node dist/cli.js …` is the test/CI entry. `bin/oat.js` calls start() itself because
 * argv[1] is the bin wrapper, not this module. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	start()
}
