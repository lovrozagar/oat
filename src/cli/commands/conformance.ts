import { EXIT } from "../../runtime/exit.ts"
import { type Args, list, str } from "../flags.ts"
import type { Writer } from "../writer.ts"
import {
	BACKENDS,
	type BackendName,
	type Leg,
	LEGS,
	type Matrix,
	type Pass,
	planPasses,
	runMatrix,
} from "./conformance-matrix.ts"
import { aggregate, writeProven } from "./conformance-proven.ts"
import { runSuites } from "./conformance-suites.ts"
import { judgeSkipped, noteD1, runCombinations } from "./conformance-tail.ts"
import { loadToolkit, type Toolkit } from "./conformance-toolkit.ts"

type Fuzzable = "memory" | "sqlite" | "postgres"

/**
 * `oat conformance`: oat against its own reference backend, every defect injected one at a time on
 * every local engine and dialect, then shapes, recall, `--ops` scope and a combination pass.
 * `--legs` runs some of those; `--proven-out` writes what they proved, and `--aggregate` judges
 * every written leg together. `--precision` and `--fuzz` replace the matrix with their own questions.
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
	const dir = str(flags, "aggregate")
	if (dir !== undefined) return aggregate(writer, toolkit, dir)
	const legs = legsOf(flags)
	const passes = await passesOf(flags, toolkit, legs)
	const suites = legs.has("suites") ? await runSuites(writer, toolkit, !includesDefault(passes)) : 0
	if (flags.precision !== undefined) return verdict(suites + (await precision(writer, flags, toolkit)))
	if (flags.fuzz !== undefined) return verdict(suites + (await fuzz(writer, flags, toolkit)))
	return verdict(suites + (await legsRun(writer, flags, toolkit, { legs, passes })))
}

function verdict(failures: number): number {
	return failures > 0 ? 1 : 0
}

/** No selector at all: the whole self-test, which alone can say a check was never proven. */
function isFull(flags: Args["flags"]): boolean {
	return ["backend", "dialect", "only", "legs", "parser"].every((name) => flags[name] === undefined)
}

/**
 * The legs a run takes: what `--legs` names; the suites alone for `--parser`; the suites and the
 * passes when a backend, dialect or defect is selected — a dialect pass runs just its pass —
 * and everything otherwise.
 */
function legsOf(flags: Args["flags"]): ReadonlySet<Leg> {
	if (flags.parser === true) return new Set(["suites"])
	const named = list(flags, "legs")
	if (named !== undefined) return new Set(named as Leg[])
	return isFull(flags) ? new Set(LEGS) : new Set(["suites", "passes"])
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
	return listRefusal(flags, toolkit)
}

/** A `--legs` or `--only` list that is empty, or names what does not exist. */
function listRefusal(flags: Args["flags"], toolkit: Toolkit): string | undefined {
	const legs = list(flags, "legs")
	const strayLegs = (legs ?? []).filter((leg) => !(LEGS as readonly string[]).includes(leg))
	if (flags.legs === true || legs?.length === 0) return `--legs needs a comma-separated list of ${LEGS.join(", ")}`
	if (strayLegs.length > 0) return `--legs names no leg: ${strayLegs.join(", ")} — expected ${LEGS.join(", ")}`
	const only = str(flags, "only")?.split(",").filter(Boolean)
	if (flags.only === true || (only !== undefined && only.length === 0))
		return "--only needs a comma-separated list of defect names"
	const unknown = (only ?? []).filter((name) => !toolkit.defects.isDefectName(name))
	if (unknown.length > 0) return `--only names no defect: ${unknown.join(", ")}`
	const strayShapes = (list(flags, "shapes") ?? []).filter((name) => !toolkit.shapes.SHAPE_NAMES.includes(name))
	return strayShapes.length === 0 ? undefined : `--shapes names no shape: ${strayShapes.join(", ")}`
}

/** The default pass: memory on the default dialect. */
function includesDefault(passes: readonly Pass[]): boolean {
	return passes.some((pass) => pass.backend === "memory" && pass.dialect === "postgrest")
}

/**
 * The passes a run makes: every local engine that answers, or the one asked for. The scope leg
 * judges from the default pass's runs, so it brings that pass when the passes leg is not taken.
 */
async function passesOf(flags: Args["flags"], toolkit: Toolkit, legs: ReadonlySet<Leg>): Promise<Pass[]> {
	if (legs.has("passes")) {
		const requested = str(flags, "backend") as BackendName | undefined
		return planPasses(
			requested === undefined ? await availableBackends(toolkit) : [requested],
			requested,
			str(flags, "dialect"),
		)
	}
	return legs.has("scope") ? [{ backend: "memory", dialect: "postgrest" }] : []
}

/** The local engines that answer: memory always; SQLite and Postgres when they are there. */
async function availableBackends(toolkit: Toolkit): Promise<BackendName[]> {
	const available: BackendName[] = ["memory"]
	if (await toolkit.suite.sqliteAvailable()) available.push("sqlite")
	if (await toolkit.suite.postgresAvailable()) available.push("postgres")
	return available
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
 * The matrix legs, then — on a full run — the engines that were missing, the checks no defect
 * proved, and the D1 note; the combination pass when its leg is taken; and what the legs proved,
 * written where `--proven-out` says.
 */
async function legsRun(
	writer: Writer,
	flags: Args["flags"],
	toolkit: Toolkit,
	run: { legs: ReadonlySet<Leg>; passes: Pass[] },
): Promise<number> {
	const { legs, passes } = run
	const matrix: Matrix = {
		jobs: Number.parseInt(str(flags, "jobs") ?? String(toolkit.pool.defaultJobs()), 10),
		legs,
		only: str(flags, "only")?.split(","),
		passes,
		shapes: list(flags, "shapes"),
	}
	const matrixLegs: Leg[] = ["passes", "shapes", "recall", "scope"]
	const ran = matrixLegs.some((leg) => legs.has(leg))
		? await runMatrix(writer, toolkit, matrix)
		: { failures: 0, proven: new Set<string>() }
	let failures = ran.failures
	const full = isFull(flags)
	if (full) {
		const available = new Set(passes.map((pass) => pass.backend))
		failures += judgeSkipped(
			writer,
			flags,
			BACKENDS.filter((backend) => backend !== "d1" && !available.has(backend)),
		)
	}
	if (legs.has("fuzz")) failures += await runCombinations(writer, flags, toolkit)
	if (full) {
		const unproven = toolkit.suite.renderUnproven(ran.proven)
		writer.out(unproven.text)
		failures += unproven.failures
		noteD1(writer, toolkit)
	}
	const out = str(flags, "proven-out")
	if (out !== undefined) writeProven(out, [...legs], ran.proven)
	return failures
}
