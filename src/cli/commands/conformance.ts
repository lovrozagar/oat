import { EXIT } from "../../runtime/exit.ts"
import { type Args, str } from "../flags.ts"
import type { Writer } from "../writer.ts"
import { BACKENDS, type BackendName, type Matrix, planPasses, runMatrix } from "./conformance-matrix.ts"
import { runSuites } from "./conformance-suites.ts"
import { judgeSkipped, noteD1, runCombinations } from "./conformance-tail.ts"
import { loadToolkit, type Toolkit } from "./conformance-toolkit.ts"

type Fuzzable = "memory" | "sqlite" | "postgres"

/**
 * `oat conformance`: oat against its own reference backend, every defect injected one at a time on
 * every local engine and dialect, then shapes, recall and a combination pass. `--parser` stops
 * after the suites; `--precision` and `--fuzz` replace the matrix with their own questions.
 */
export async function commandConformance(
	writer: Writer,
	flags: Args["flags"],
	load: () => Promise<Toolkit> = loadToolkit,
): Promise<number> {
	const toolkit = await load()
	const refused = refusal(flags, toolkit)
	if (refused !== undefined) {
		writer.err(`oat: ${refused}\n`)
		return EXIT.usage
	}
	const beforeMatrix = flags.parser === true || flags.precision !== undefined || flags.fuzz !== undefined
	const suites = await runSuites(writer, toolkit, beforeMatrix)
	if (flags.parser === true) return verdict(suites)
	if (flags.precision !== undefined) return verdict(suites + (await precision(writer, flags, toolkit)))
	if (flags.fuzz !== undefined) return verdict(suites + (await fuzz(writer, flags, toolkit)))
	return verdict(suites + (await fullRun(writer, flags, toolkit)))
}

function verdict(failures: number): number {
	return failures > 0 ? 1 : 0
}

/**
 * A typo in a selector must stop the run, not widen it: an unknown backend once ran every backend,
 * and an unknown dialect silently filtered out the defects it could not express.
 */
function refusal(flags: Args["flags"], toolkit: Toolkit): string | undefined {
	const backend = str(flags, "backend")
	if (backend !== undefined && !(BACKENDS as readonly string[]).includes(backend)) {
		return `unknown --backend "${backend}" — expected ${BACKENDS.join(", ")}`
	}
	const dialects = toolkit.dialect.DIALECTS
	const dialect = str(flags, "dialect")
	if (dialect !== undefined && !Object.hasOwn(dialects, dialect)) {
		return `unknown --dialect "${dialect}" — expected ${Object.keys(dialects).join(", ")}`
	}
	const only = str(flags, "only")?.split(",").filter(Boolean)
	if (flags.only === true || (only !== undefined && only.length === 0))
		return "--only needs a comma-separated list of defect names"
	const unknown = (only ?? []).filter((name) => !toolkit.defects.isDefectName(name))
	return unknown.length === 0 ? undefined : `--only names no defect: ${unknown.join(", ")}`
}

/** Varies the data rather than the faults, against a backend with nothing wrong with it: any finding is a false positive. */
async function precision(writer: Writer, flags: Args["flags"], toolkit: Toolkit): Promise<number> {
	const rendered = toolkit.fuzz.renderPrecision(
		await toolkit.fuzz.runPrecision({
			backend: (str(flags, "backend") ?? "memory") as Fuzzable,
			cases: typeof flags.precision === "string" ? Number.parseInt(flags.precision, 10) : 50,
			dialect: str(flags, "dialect") ?? "postgrest",
			seed: Number.parseInt(str(flags, "seed") ?? "1", 10) || 1,
		}),
	)
	writer.out(rendered.text)
	return rendered.failures
}

/** Whether the diagnosis survives several simultaneous faults: its own question, so it replaces the matrix. */
async function fuzz(writer: Writer, flags: Args["flags"], toolkit: Toolkit): Promise<number> {
	const rendered = toolkit.fuzz.renderFuzz(
		await toolkit.fuzz.runFuzz({
			backend: (str(flags, "backend") ?? "memory") as Fuzzable,
			cases: typeof flags.fuzz === "string" ? Number.parseInt(flags.fuzz, 10) : 25,
			dialect: str(flags, "dialect") ?? "postgrest",
			maxDefects: Number.parseInt(str(flags, "max-defects") ?? "4", 10),
			seed: Number.parseInt(str(flags, "seed") ?? "1", 10) || 1,
		}),
	)
	writer.out(rendered.text)
	return rendered.failures
}

/**
 * The defect matrix on every local engine — the in-memory store and real SQL both, since a check
 * that passes only in memory relied on JavaScript semantics (NULL ordering, collation, LIKE
 * escaping) a database does not share — then the engines that were missing, the combination pass
 * and the D1 note.
 */
async function fullRun(writer: Writer, flags: Args["flags"], toolkit: Toolkit): Promise<number> {
	const requested = str(flags, "backend") as BackendName | undefined
	const available = await availableBackends(toolkit)
	const dialect = str(flags, "dialect")
	const only = str(flags, "only")?.split(",")
	const matrix: Matrix = {
		dialect,
		jobs: Number.parseInt(str(flags, "jobs") ?? String(toolkit.pool.defaultJobs()), 10),
		only,
		passes: planPasses(requested === undefined ? available : [requested], requested, dialect),
		requested,
	}
	let failures = await runMatrix(writer, toolkit, matrix)
	if (requested !== undefined) return failures
	failures += judgeSkipped(
		writer,
		flags,
		BACKENDS.filter((backend) => backend !== "d1" && !available.includes(backend)),
	)
	if (only === undefined) failures += await runCombinations(writer, flags, toolkit)
	noteD1(writer, toolkit)
	return failures
}

/** The local engines that answer: memory always; SQLite and Postgres when they are there. */
async function availableBackends(toolkit: Toolkit): Promise<BackendName[]> {
	const available: BackendName[] = ["memory"]
	if (await toolkit.suite.sqliteAvailable()) available.push("sqlite")
	if (await toolkit.suite.postgresAvailable()) available.push("postgres")
	return available
}
