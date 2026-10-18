import type { Writer } from "../writer.ts"
import type { Toolkit } from "./conformance-toolkit.ts"

export const BACKENDS = ["memory", "sqlite", "postgres", "d1"] as const
export type BackendName = (typeof BACKENDS)[number]

/** The parts of the self-test, each runnable on its own: `--legs suites,passes,…`. */
export const LEGS = ["suites", "passes", "shapes", "recall", "scope", "fuzz"] as const
export type Leg = (typeof LEGS)[number]

/** One leg of the matrix: every defect against one storage engine in one API dialect. */
export interface Pass {
	backend: BackendName
	dialect: string
}

/** What the matrix runs: its passes, its legs, and what the flags narrowed. */
export interface Matrix {
	passes: Pass[]
	legs: ReadonlySet<Leg>
	/** Defect names `--only` kept; all when absent. */
	only: string[] | undefined
	/** Shapes `--shapes` kept for the shapes and recall legs; all when absent. */
	shapes: string[] | undefined
	jobs: number
}

/**
 * The legs to run. Backends vary the storage engine; dialects vary the API's conventions. The full
 * cross product would be mostly redundant, so every backend runs the default dialect and the
 * cheapest one runs the other shapes: `classic` renames everything, `linked` changes the pagination
 * model, and `template` is a grammar oat knows only from its declaration.
 */
export function planPasses(
	backends: readonly BackendName[],
	requested: string | undefined,
	dialect: string | undefined,
): Pass[] {
	if (dialect !== undefined || requested !== undefined) {
		return backends.map((backend) => ({ backend, dialect: dialect ?? "postgrest" }))
	}
	return [
		...backends.map((backend) => ({ backend, dialect: "postgrest" })),
		...["classic", "linked", "jsonapi", "plain", "template"].map((extra) => ({
			backend: "memory" as const,
			dialect: extra,
		})),
	]
}

/** How many defects one task carries: a long leg spreads across the pool. */
const CHUNK = 6

/** `items` in slices of `CHUNK`. */
function chunked<T>(items: readonly T[]): T[][] {
	return Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, index) =>
		items.slice(index * CHUNK, (index + 1) * CHUNK),
	)
}

type Pool = ReturnType<Toolkit["pool"]["createPool"]>
type PassAnswer = ReturnType<Toolkit["suite"]["passAnswer"]> & { seconds: number }
type ShapeCase = Parameters<Toolkit["shapes"]["renderShapeSuite"]>[0][number]

/** The matrix as it runs: its printer, its pool, what it has failed and proven, and the largest worker it saw. */
interface MatrixRun {
	writer: Writer
	toolkit: Toolkit
	matrix: Matrix
	pool: Pool
	started: number
	failures: number
	/** Checks some defect proved: the ones a full run never proves are reported. */
	proven: Set<string>
	/** The most memory any worker held after a task, in bytes. */
	peakRss: number
}

/** Seconds since `since`, to a tenth. */
function seconds(since: number): number {
	return Math.round((performance.now() - since) / 100) / 10
}

/** Every pass queued at once; its baselines and its defects in chunks, its results back in order. */
function queuePasses(run: MatrixRun): Array<Promise<PassAnswer>> {
	const { toolkit, pool, matrix } = run
	return matrix.passes.map(async (pass) => {
		const defects = toolkit.suite.defectsFor(pass.backend, pass.dialect, matrix.only)
		const answers = await Promise.all([
			pool.run({ backend: pass.backend, dialect: pass.dialect, kind: "baselines" }),
			...chunked(defects).map((chunk) =>
				pool.run({ backend: pass.backend, dialect: pass.dialect, defects: chunk, kind: "defects" }),
			),
		])
		for (const answer of answers) run.peakRss = Math.max(run.peakRss, answer.memory.rss)
		const results = answers.flatMap((answer) => answer.results)
		return { ...toolkit.suite.passAnswer(results, pass.backend, pass.dialect), seconds: seconds(run.started) }
	})
}

/** The default shape's checks, then every shape on its own task, judged against them. */
async function queueShapes(run: MatrixRun): Promise<ShapeCase[]> {
	const { pool, toolkit } = run
	const reference = await pool.run({ kind: "shape-reference" })
	const answers = await Promise.all(
		toolkit.shapes.SHAPE_NAMES.filter((name) => run.matrix.shapes?.includes(name) ?? true).map((name) =>
			pool.run({ kind: "shape", name, reference: reference.checks }),
		),
	)
	for (const answer of [reference, ...answers]) run.peakRss = Math.max(run.peakRss, answer.memory.rss)
	return answers.flatMap((answer) => answer.cases)
}

/**
 * Recall behind each shape that runs clean, a chunk of defects per task; a shape that does not
 * waits on itself. Each shape says on stderr when its recall is done, so a long step shows it moves.
 */
async function queueRecall(run: MatrixRun, shapes: Promise<ShapeCase[]>): Promise<ShapeCase[]> {
	const { pool, toolkit, writer } = run
	const perShape = (await shapes).map(async (shape) => {
		if (shape.problems.length > 0) return [toolkit.shapes.waitingRecall(shape)]
		const name = shape.label.replace(/^shape:/, "")
		const began = performance.now()
		const answers = await Promise.all(
			chunked(toolkit.shapes.recallDefects("memory", name)).map((defects) =>
				pool.run({ defects, kind: "recall", shape: name }),
			),
		)
		for (const answer of answers) run.peakRss = Math.max(run.peakRss, answer.memory.rss)
		const cases = answers.flatMap((answer) => answer.cases)
		const unexpected = toolkit.shapes.renderShapeSuite(cases, true).failures
		writer.err(`  recall behind ${name}: ${cases.length} case(s), ${unexpected} not as expected · ${seconds(began)}s\n`)
		return cases
	})
	return (await Promise.all(perShape)).flat()
}

/** What only a whole matrix can judge, queued beside the passes. */
interface Extras {
	shapes: Promise<ShapeCase[]> | undefined
	recall: Promise<ShapeCase[]> | undefined
	scope: Promise<Array<{ results: Parameters<Toolkit["suite"]["renderParserSuite"]>[0] }>> | undefined
}

/** The default pass: memory on the default dialect, whose runs the tag-unlock and `--ops` claims are judged from. */
function defaultPass(matrix: Matrix): number {
	return matrix.passes.findIndex((pass) => pass.backend === "memory" && pass.dialect === "postgrest")
}

/**
 * Shapes and recall — whether oat stays quiet on a correct backend shaped unlike the one it was
 * written against, and still sees each defect behind it; one engine is enough, a shape varies the
 * API, not the storage — and `--ops` recall, which needs each defect's full run from the default pass.
 */
function queueExtras(run: MatrixRun, answers: Array<Promise<PassAnswer>>): Extras {
	const { matrix, pool, toolkit } = run
	const shapes = matrix.legs.has("shapes") || matrix.legs.has("recall") ? queueShapes(run) : undefined
	const recall = shapes !== undefined && matrix.legs.has("recall") ? queueRecall(run, shapes) : undefined
	const index = defaultPass(matrix)
	const scope =
		!matrix.legs.has("scope") || index === -1
			? undefined
			: (answers[index] as Promise<PassAnswer>).then((answer) => {
					const names = Object.keys(toolkit.defects.DEFECTS)
					const lanes = Array.from({ length: matrix.jobs }, (_, lane) =>
						names.filter((_name, at) => at % matrix.jobs === lane),
					)
					return Promise.all(
						lanes
							.filter((lane) => lane.length > 0)
							.map((defects) => pool.run({ defects, kind: "scope", known: answer.primaryOps })),
					)
				})
	return { recall, scope, shapes }
}

/** The legs asked for, printed in order as each is answered. Returns what failed and what was proven. */
export async function runMatrix(
	writer: Writer,
	toolkit: Toolkit,
	matrix: Matrix,
): Promise<{ failures: number; proven: Set<string> }> {
	const pool = toolkit.pool.createPool(matrix.jobs)
	const run: MatrixRun = {
		failures: 0,
		matrix,
		peakRss: 0,
		pool,
		proven: new Set(),
		started: performance.now(),
		toolkit,
		writer,
	}
	try {
		const answers = queuePasses(run)
		const extras = queueExtras(run, answers)
		/* Observed from the start: when one leg fails, the rest must not surface as unhandled. */
		void Promise.allSettled([...answers, extras.shapes, extras.recall, extras.scope])
		for (const [index, pass] of matrix.passes.entries()) {
			writer.out(`\n  ── ${pass.backend} · ${pass.dialect} ${"─".repeat(46)}\n`)
			const answer = await (answers[index] as Promise<PassAnswer>)
			writer.out(`${answer.text}  done in ${answer.seconds}s\n`)
			run.failures += answer.failures
			for (const id of answer.proven) run.proven.add(id)
		}
		await judgeWhole(run, answers, extras)
	} finally {
		await pool.close()
	}
	if (run.peakRss > 0) writer.out(`  largest worker: ${Math.round(run.peakRss / 2 ** 20)} MB\n`)
	return { failures: run.failures, proven: run.proven }
}

/** The tag-unlock claims from the default pass's runs, `--ops` recall, and the shapes and recall. */
async function judgeWhole(run: MatrixRun, answers: Array<Promise<PassAnswer>>, extras: Extras): Promise<void> {
	const index = defaultPass(run.matrix)
	if (index !== -1)
		print(run, await run.toolkit.suite.runTagUnlockSuite((await (answers[index] as Promise<PassAnswer>)).baselines))
	if (extras.scope !== undefined)
		print(
			run,
			(await extras.scope).flatMap((answer) => answer.results),
		)
	if (extras.shapes !== undefined) await judgeShapes(run, extras.shapes)
	if (extras.recall !== undefined) await judgeRecall(run, extras.recall)
}

function print(run: MatrixRun, cases: Parameters<Toolkit["suite"]["renderParserSuite"]>[0]): void {
	const rendered = run.toolkit.suite.renderParserSuite(cases)
	run.writer.out(rendered.text)
	run.failures += rendered.failures
}

async function judgeShapes(run: MatrixRun, shapes: Promise<ShapeCase[]>): Promise<void> {
	run.writer.out(`\n  ── shapes · memory ${"─".repeat(46)}\n`)
	const rendered = run.toolkit.shapes.renderShapeSuite(await shapes)
	run.writer.out(`${rendered.text}  done in ${seconds(run.started)}s\n`)
	run.failures += rendered.failures
}

/** Recall behind the shapes: a defect only a shape can show proves its check there. */
async function judgeRecall(run: MatrixRun, recall: Promise<ShapeCase[]>): Promise<void> {
	const { writer, toolkit } = run
	writer.out(`\n  ── recall behind shapes · memory ${"─".repeat(32)}\n`)
	const cases = await recall
	const rendered = toolkit.shapes.renderShapeSuite(cases, true)
	writer.out(`${rendered.text}  done in ${seconds(run.started)}s\n`)
	run.failures += rendered.failures
	const expected = toolkit.suite.EXPECTED as Record<string, string | string[]>
	for (const recalled of cases) {
		const defect = /^recall:[^:]+:(.+)$/.exec(recalled.label)?.[1]
		const check = defect === undefined ? undefined : expected[defect]
		if (check === undefined || recalled.problems.length > 0) continue
		/* The check a defect proves is the first it names. */
		for (const id of [check].flat().slice(0, 1)) run.proven.add(id)
	}
}
