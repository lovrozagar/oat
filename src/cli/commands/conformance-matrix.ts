import type { Writer } from "../writer.ts"
import type { Toolkit } from "./conformance-toolkit.ts"

export const BACKENDS = ["memory", "sqlite", "postgres", "d1"] as const
export type BackendName = (typeof BACKENDS)[number]

/** One leg of the matrix: every defect against one storage engine in one API dialect. */
export interface Pass {
	backend: BackendName
	dialect: string
}

/** What the matrix runs: its passes, and what the flags narrowed. */
export interface Matrix {
	passes: Pass[]
	/** Defect names `--only` kept; all when absent. */
	only: string[] | undefined
	requested: BackendName | undefined
	dialect: string | undefined
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

/** How many defects a leg sends at once: a long leg spreads across the pool. */
const LEG_CHUNK = 6

type Pool = ReturnType<Toolkit["pool"]["createPool"]>
type PassAnswer = { kind: "pass" } & ReturnType<Toolkit["suite"]["passAnswer"]>

/** Every leg queued at once; its baselines and its defects in chunks, its results back in order. */
function queuePasses(toolkit: Toolkit, pool: Pool, matrix: Matrix): Array<Promise<PassAnswer>> {
	return matrix.passes.map(async (pass) => {
		const defects = toolkit.suite.defectsFor(pass.backend, pass.dialect, matrix.only)
		const chunks = Array.from({ length: Math.ceil(defects.length / LEG_CHUNK) }, (_, index) =>
			defects.slice(index * LEG_CHUNK, (index + 1) * LEG_CHUNK),
		)
		const answers = await Promise.all([
			pool.run({ backend: pass.backend, dialect: pass.dialect, kind: "baselines" }),
			...chunks.map((chunk) =>
				pool.run({ backend: pass.backend, dialect: pass.dialect, defects: chunk, kind: "defects" }),
			),
		])
		const results = answers.flatMap((answer) => answer.results)
		return { kind: "pass" as const, ...toolkit.suite.passAnswer(results, pass.backend, pass.dialect) }
	})
}

/** The legs, printed in order as each is answered, then the claims only a whole matrix can judge. */
export async function runMatrix(writer: Writer, toolkit: Toolkit, matrix: Matrix): Promise<number> {
	const pool = toolkit.pool.createPool(matrix.jobs)
	const run: MatrixRun = { failures: 0, matrix, pool, proven: new Set(), toolkit, writer }
	try {
		const answers = queuePasses(toolkit, pool, matrix)
		const extras = queueExtras(run, answers)
		/* Observed from the start: when one leg fails, the rest must not surface as unhandled. */
		void Promise.allSettled([...answers, extras.shapes, extras.scope, extras.recall])
		for (const [index, pass] of matrix.passes.entries()) {
			writer.out(`\n  ── ${pass.backend} · ${pass.dialect} ${"─".repeat(46)}\n`)
			const answer = await (answers[index] as Promise<PassAnswer>)
			writer.out(answer.text)
			run.failures += answer.failures
			for (const id of answer.proven) run.proven.add(id)
		}
		await judgeWhole(run, answers, extras)
	} finally {
		await pool.close()
	}
	return run.failures
}

interface MatrixRun {
	writer: Writer
	toolkit: Toolkit
	matrix: Matrix
	pool: Pool
	failures: number
	/** Checks some defect proved: the ones a full run never proves are reported. */
	proven: Set<string>
}

type Cases = Awaited<ReturnType<Pool["run"]>> & { kind: "cases" }

interface Extras {
	shapes: Promise<Cases> | undefined
	scope: Promise<Array<{ results: Parameters<Toolkit["suite"]["renderParserSuite"]>[0] }>> | undefined
	recall: Promise<Cases[]> | undefined
}

/** A full run of every defect and backend, nothing narrowed. */
function isFull({ only, requested, dialect }: Matrix): boolean {
	return only === undefined && requested === undefined && dialect === undefined
}

/**
 * Work queued beside the legs: the correct backends shaped unlike the fixture (one engine is
 * enough — a shape varies the API, not the storage), recall behind those shapes, and `--ops`
 * recall, which needs each defect's full run from the default leg.
 */
function queueExtras(run: MatrixRun, answers: Array<Promise<PassAnswer>>): Extras {
	const { matrix, pool, toolkit } = run
	const shapes =
		matrix.requested === undefined || matrix.requested === "memory" ? pool.run({ kind: "shapes" }) : undefined
	const recall =
		shapes === undefined || matrix.only !== undefined
			? undefined
			: shapes.then((answer) => Promise.all(answer.cases.map((shape) => pool.run({ kind: "recall", shapes: [shape] }))))
	const defaultLeg = matrix.passes.findIndex((pass) => pass.backend === "memory" && pass.dialect === "postgrest")
	const scope =
		!isFull(matrix) || defaultLeg === -1
			? undefined
			: (answers[defaultLeg] as Promise<PassAnswer>).then((answer) => {
					const names = Object.keys(toolkit.defects.DEFECTS)
					const lanes = Array.from({ length: matrix.jobs }, (_, lane) =>
						names.filter((_name, index) => index % matrix.jobs === lane),
					)
					const known = answer.primaryOps
					return Promise.all(
						lanes.filter((lane) => lane.length > 0).map((defects) => pool.run({ defects, kind: "scope", known })),
					)
				})
	return { recall, scope, shapes }
}

/** The tag-unlock claims, `--ops` recall, the shapes and recall behind them, and the checks never proven. */
async function judgeWhole(run: MatrixRun, answers: Array<Promise<PassAnswer>>, extras: Extras): Promise<void> {
	const { writer, toolkit, matrix } = run
	const defaultLeg = matrix.passes.findIndex((pass) => pass.backend === "memory" && pass.dialect === "postgrest")
	const baselines = defaultLeg === -1 ? undefined : (await (answers[defaultLeg] as Promise<PassAnswer>)).baselines
	print(run, await toolkit.suite.runTagUnlockSuite(baselines))
	if (extras.scope !== undefined)
		print(
			run,
			(await extras.scope).flatMap((answer) => answer.results),
		)
	if (extras.shapes !== undefined) await judgeShapes(run, extras)
	/* Only a complete run can say a check was never proven; a filtered one never tried. */
	if (isFull(matrix)) {
		const unproven = toolkit.suite.renderUnproven(run.proven)
		writer.out(unproven.text)
		run.failures += unproven.failures
	}
}

function print(run: MatrixRun, cases: Parameters<Toolkit["suite"]["renderParserSuite"]>[0]): void {
	const rendered = run.toolkit.suite.renderParserSuite(cases)
	run.writer.out(rendered.text)
	run.failures += rendered.failures
}

/**
 * The opposite question to the defect matrix: whether oat stays quiet on a correct backend shaped
 * unlike the one it was written against. Then recall behind each shape: a defect only a shape can
 * show proves its check there.
 */
async function judgeShapes(run: MatrixRun, extras: Extras): Promise<void> {
	const { writer, toolkit } = run
	writer.out(`\n  ── shapes · memory ${"─".repeat(46)}\n`)
	const answer = (await extras.shapes) as Cases
	const shapes = toolkit.shapes.renderShapeSuite(answer.cases)
	writer.out(shapes.text)
	run.failures += shapes.failures
	if (extras.recall === undefined) return
	writer.out(`\n  ── recall behind shapes · memory ${"─".repeat(32)}\n`)
	const cases = (await extras.recall).flatMap((recalled) => recalled.cases)
	const recall = toolkit.shapes.renderShapeSuite(cases, true)
	writer.out(recall.text)
	run.failures += recall.failures
	const expected = toolkit.suite.EXPECTED as Record<string, string | string[]>
	for (const recalled of cases) {
		const defect = /^recall:[^:]+:(.+)$/.exec(recalled.label)?.[1]
		const check = defect === undefined ? undefined : expected[defect]
		if (check === undefined || recalled.problems.length > 0) continue
		/* The check a defect proves is the first it names. */
		for (const id of [check].flat().slice(0, 1)) run.proven.add(id)
	}
}
