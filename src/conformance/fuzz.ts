/**
 * Combination fuzzing: many defects at once, chosen at random.
 *
 * The defect matrix injects one fault at a time, which is not how a backend fails. Real ones
 * carry several simultaneously, and that interaction is where a tool quietly stops being useful:
 * a broken listing makes every downstream check report a consequence, and a report of thirty
 * findings with one root cause is nearly as useless as a report of none.
 *
 * So the oracle here is not "did every injected defect produce a finding". It is:
 *
 *   - **recall** — each injected defect's primary check fired, *or* was legitimately suppressed
 *     because a check it depends on was itself broken by another injected defect;
 *   - **precision** — no finding outside the union of what the injected set can justify.
 *
 * Suppression is the interesting half. Counting a suppressed check as a miss would push oat
 * toward reporting cascades; counting any suppression as fine would let it hide real defects
 * behind unrelated ones. The dependency graph is what separates those two, so it is consulted
 * rather than assumed.
 */

import { messageOf } from "../errors/message.ts"
import type { DefectName } from "../reference/defects/table.ts"
import type { RunResult } from "../runtime/run/index.ts"
import { run } from "./harness/counting.ts"
import { type FuzzCase, diagnose, falsePositives, type PrecisionCase } from "./fuzz/diagnose.ts"
import { launch, listening, reach, type Target, type Via } from "./harness/launch.ts"
import { defectsFor } from "./matrix/defects.ts"
import type { Backend } from "./matrix/engines.ts"
import { optInFor } from "./matrix/opt-in.ts"
import { PRINCIPALS, SECURITY } from "./matrix/principals.ts"

export type { FuzzCase, PrecisionCase } from "./fuzz/diagnose.ts"
export { renderFuzz, renderPrecision } from "./fuzz/render.ts"

/** Where fuzzing runs: an engine and dialect, reached behind a socket unless `via` says otherwise. */
interface FuzzTarget {
	/** A local engine; D1 is not fuzzed. */
	backend?: Exclude<Backend, "d1">
	dialect?: string
	via?: Via
}

export interface FuzzOptions extends FuzzTarget {
	cases?: number
	maxDefects?: number
	seed?: number
	onCase?: (result: FuzzCase) => void
}

export interface PrecisionOptions extends FuzzTarget {
	cases?: number
	seed?: number
}

/** Deterministic PRNG so a failing case can be replayed from its seed alone. */
function rng(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0
		return state / 0x1_00_00_00_00
	}
}

function targetOf({ backend = "memory", dialect = "postgrest", via = listening }: FuzzTarget): Target {
	return { backend, dialect, via }
}

export async function runFuzz(options: FuzzOptions = {}): Promise<FuzzCase[]> {
	const { cases = 25, maxDefects = 4, seed: rootSeed = 1 } = options
	const target = targetOf(options)

	/* Defects the chosen backend or dialect cannot express are excluded from the draw rather than
	 * excused afterwards — a case that cannot fail teaches nothing and still costs a run. */
	const pool = defectsFor(target.backend, target.dialect)

	const results: FuzzCase[] = []
	const random = rng(rootSeed)

	for (let index = 0; index < cases; index++) {
		const caseSeed = Math.floor(random() * 1_000_000)
		const result = await runOneCase(target, drawDefects(pool, caseSeed, maxDefects), caseSeed)
		results.push(result)
		options.onCase?.(result)
	}

	return results
}

/** Between one and `maxDefects` distinct defects from `pool`, as `seed` draws them. */
function drawDefects(pool: readonly DefectName[], seed: number, maxDefects: number): DefectName[] {
	const draw = rng(seed)
	const count = 1 + Math.floor(draw() * maxDefects)
	const injected: DefectName[] = []
	while (injected.length < count) {
		const pick = pool[Math.floor(draw() * pool.length)] as DefectName
		if (!injected.includes(pick)) injected.push(pick)
	}
	return injected
}

/**
 * oat run once against the target's reference with `defects` injected, `seed` shaping its data.
 * A reference that will not start fails the whole pass; a run that fails is the case's own result.
 */
async function runAgainst(
	target: Target,
	defects: DefectName[],
	seed: number,
): Promise<{ result: RunResult } | { error: string }> {
	/* A defect behind an opt-in shows only with it on, in the reference and in oat both. */
	const optIn = optInFor(defects)
	const server = await launch(target, { defects, ...optIn.reference })
	try {
		return {
			result: await run({
				...optIn.run,
				baseUrl: server.url,
				principals: PRINCIPALS,
				security: SECURITY,
				seed,
				spec: `${server.url}/v1/openapi/spec`,
				...reach(server),
			}),
		}
	} catch (error) {
		return { error: messageOf(error) }
	} finally {
		await server.close()
	}
}

async function runOneCase(target: Target, injected: DefectName[], seed: number): Promise<FuzzCase> {
	const outcome = await runAgainst(target, injected, 42)
	if ("error" in outcome) {
		const { error } = outcome
		return {
			cascaded: [],
			error,
			excused: [],
			findings: 0,
			injected,
			missed: [],
			ok: false,
			seed,
			spurious: [],
			unresolved: [],
		}
	}
	return { injected, seed, ...diagnose(injected, outcome.result) }
}

/**
 * Precision under varied data, against a backend with no defects at all.
 *
 * The combination fuzzer varies the *faults*; this varies the *data*. Every check builds its
 * cohort from a seed — empty strings, LIKE metacharacters, unicode, nulls, lexical extremes — and
 * the conformance suite has only ever used seed 42. A property that holds at 42 and fails at 43
 * was never a property of the contract; it was a property of that one fixture.
 *
 * Here the backend is correct by construction, so the bar is absolute: any finding at all is a
 * false positive, and false positives are what make a tool get switched off.
 */
export async function runPrecision(options: PrecisionOptions = {}): Promise<PrecisionCase[]> {
	const { cases = 50, seed: rootSeed = 1 } = options
	const target = targetOf(options)
	const results: PrecisionCase[] = []
	const random = rng(rootSeed)

	for (let index = 0; index < cases; index++) {
		const seed = Math.floor(random() * 1_000_000)
		const outcome = await runAgainst(target, [], seed)
		results.push(
			"error" in outcome
				? { error: outcome.error, findings: [], inconclusive: 0, seed }
				: { findings: falsePositives(outcome.result), inconclusive: outcome.result.inconclusive.length, seed },
		)
	}

	return results
}
