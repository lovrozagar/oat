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

import { DEFECTS, type DefectName } from "../reference/defects.ts"
import { CHECKS } from "../runtime/checks.ts"
import { type PrincipalSpec, run } from "../runtime/run.ts"
import {
	type Backend,
	COUNT_ONLY,
	CURSOR_ONLY,
	DIALECTS_WITH_CURSOR,
	DIALECTS_WITH_FILTER_EXPRESSION,
	DIALECTS_WITH_POSTGREST_FILTER,
	DIALECTS_WITH_TOTAL,
	EXPRESSION_ONLY,
	EXPECTED,
	POSTGREST_OP_ONLY,
	PRINCIPALS,
	SQL_ONLY,
} from "./suite.ts"

export interface FuzzCase {
	seed: number
	injected: DefectName[]
	/** Injected defects whose primary check neither fired nor was justifiably suppressed. */
	missed: Array<{ defect: DefectName; primary: string }>
	/**
	 * Findings no injected defect accounts for.
	 *
	 * Carries the summary and evidence, not just the check id. A failure here is often rare —
	 * timing-sensitive cases surface once in several hundred runs — and re-running to find out
	 * what happened may simply not reproduce it. The report has to be enough on its own.
	 */
	spurious: Array<{ check: string; entity: string; summary: string; detail: string }>
	/** Injected defects whose check was suppressed by a broken dependency — expected, not a miss. */
	cascaded: Array<{ defect: DefectName; because: string }>
	/**
	 * Injected defects whose check ran, could not reach a verdict, and said so.
	 *
	 * Not a pass and not a miss. The defect went unreported, but the report names the check and
	 * the reason, which is what lets a reader re-run it once the blocking condition is gone. The
	 * failure this separates it from — a check that gives up in silence — is indistinguishable
	 * from a clean result, and that is the one worth failing the suite over.
	 */
	unresolved: Array<{ defect: DefectName; reason: string }>
	findings: number
	ok: boolean
	error?: string
}

/** Deterministic PRNG so a failing case can be replayed from its seed alone. */
function rng(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0
		return state / 0x1_00_00_00_00
	}
}

function primary(defect: DefectName): string {
	const expected = EXPECTED[defect]
	return Array.isArray(expected) ? (expected[0] ?? "") : expected
}

function acceptable(defect: DefectName): string[] {
	const expected = EXPECTED[defect]
	return Array.isArray(expected) ? expected : [expected]
}

/** Every check id reachable from `id` by following `dependsOn`, transitively. */
function ancestorsOf(id: string, seen = new Set<string>()): Set<string> {
	const check = CHECKS.find((candidate) => candidate.id === id)
	for (const parent of check?.dependsOn ?? []) {
		if (seen.has(parent)) continue
		seen.add(parent)
		ancestorsOf(parent, seen)
	}
	return seen
}

export interface FuzzOptions {
	cases?: number
	maxDefects?: number
	backend?: Backend
	dialect?: string
	seed?: number
	onCase?: (result: FuzzCase) => void
}

export async function runFuzz(options: FuzzOptions = {}): Promise<FuzzCase[]> {
	const { backend = "memory", cases = 25, dialect = "postgrest", maxDefects = 4, seed: rootSeed = 1 } = options

	const { createMemoryServer, createPostgresServer, createSqliteServer } = await import("../reference/http.ts")
	const factory =
		backend === "memory" ? createMemoryServer : backend === "sqlite" ? createSqliteServer : createPostgresServer

	/* Defects the chosen backend or dialect cannot express are excluded from the draw rather than
	 * excused afterwards — a case that cannot fail teaches nothing and still costs a run. */
	const pool = (Object.keys(DEFECTS) as DefectName[]).filter(
		(name) =>
			(backend !== "memory" || !SQL_ONLY.has(name)) &&
			(DIALECTS_WITH_CURSOR.has(dialect) || !CURSOR_ONLY.has(name)) &&
			/* A shape publishing no total cannot publish a wrong one, so drawing a count defect
			 * against it produces a case that cannot fail — and then fails, because nothing
			 * detects a defect with nowhere to happen. */
			(DIALECTS_WITH_TOTAL.has(dialect) || !COUNT_ONLY.has(name)) &&
			(DIALECTS_WITH_FILTER_EXPRESSION.has(dialect) || !EXPRESSION_ONLY.has(name)) &&
			(DIALECTS_WITH_POSTGREST_FILTER.has(dialect) || !POSTGREST_OP_ONLY.has(name)),
	)

	const results: FuzzCase[] = []
	const random = rng(rootSeed)

	for (let index = 0; index < cases; index++) {
		const caseSeed = Math.floor(random() * 1_000_000)
		const draw = rng(caseSeed)
		const count = 1 + Math.floor(draw() * maxDefects)

		const injected: DefectName[] = []
		while (injected.length < count) {
			const pick = pool[Math.floor(draw() * pool.length)] as DefectName
			if (!injected.includes(pick)) injected.push(pick)
		}

		const result = await runOneCase(factory, injected, caseSeed, dialect)
		results.push(result)
		options.onCase?.(result)
	}

	return results
}

type Factory = (options: {
	defects?: string[]
	dialect?: string
}) => Promise<{ url: string; close: () => Promise<void> }>

async function runOneCase(factory: Factory, injected: DefectName[], seed: number, dialect: string): Promise<FuzzCase> {
	const base: FuzzCase = {
		cascaded: [],
		findings: 0,
		unresolved: [],
		injected,
		missed: [],
		ok: false,
		seed,
		spurious: [],
	}

	const server = await factory({ defects: injected, dialect })
	try {
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS as PrincipalSpec[],
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})

		/* Coverage gaps describe what oat could not test, not what the backend got wrong. */
		const real = result.findings.filter((finding) => finding.verdict !== "COVERAGE_GAP")
		const fired = new Set(real.map((finding) => finding.check))
		base.findings = real.length

		/* Anything the injected set can justify — the primaries plus their documented
		 * consequences. A finding outside this union is oat inventing a defect. */
		const justified = new Set(injected.flatMap(acceptable))

		const stated = new Map(result.inconclusive.map((entry) => [entry.check, entry.reason] as const))

		for (const defect of injected) {
			const want = primary(defect)
			if (fired.has(want)) continue
			/* Not fired. Acceptable in exactly two cases: something `want` depends on is itself
			 * broken — cascade suppression working — or the check ran and reported *why* it could
			 * not conclude. Anything else is oat going quiet, which is the real failure. */
			const broken = [...ancestorsOf(want)].find((ancestor) => fired.has(ancestor))
			if (broken !== undefined) {
				base.cascaded.push({ because: broken, defect })
				continue
			}
			const reason = stated.get(want)
			if (reason !== undefined) {
				base.unresolved.push({ defect, reason })
				continue
			}
			base.missed.push({ defect, primary: want })
		}

		for (const finding of real) {
			if (justified.has(finding.check)) continue
			base.spurious.push({
				check: finding.check,
				detail: finding.detail,
				entity: finding.entity ?? "",
				summary: finding.summary,
			})
		}

		base.ok = base.missed.length === 0 && base.spurious.length === 0
		return base
	} catch (error) {
		base.error = error instanceof Error ? error.message : String(error)
		return base
	} finally {
		await server.close()
	}
}

export function renderFuzz(results: FuzzCase[]): { text: string; failures: number } {
	const lines: string[] = []
	const failed = results.filter((result) => !result.ok)
	lines.push("")
	lines.push("  combination fuzzing — random defect sets, one run each")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")

	for (const result of failed) {
		lines.push(`  ✗ seed ${result.seed}  [${result.injected.join(" + ")}]`)
		if (result.error !== undefined) lines.push(`      run failed: ${result.error}`)
		for (const miss of result.missed) {
			lines.push(`      missed   ${miss.defect} — expected ${miss.primary}, nothing fired`)
		}
		for (const extra of result.spurious) {
			lines.push(`      spurious ${extra.check}${extra.entity === "" ? "" : ` (${extra.entity})`}`)
			lines.push(`               ${extra.summary}`)
			/* Truncated, not omitted: the evidence is what distinguishes a real regression from a
			 * timing artefact, and a rare case may never reproduce on demand. */
			lines.push(`               ${extra.detail.replace(/\s+/g, " ").slice(0, 200)}`)
		}
	}

	const cascaded = results.reduce((sum, result) => sum + result.cascaded.length, 0)
	const unresolved = results.reduce((sum, result) => sum + result.unresolved.length, 0)
	lines.push("")
	lines.push(
		`  ${results.length - failed.length}/${results.length} combinations diagnosed correctly` +
			` · ${cascaded} suppressed as cascades` +
			` · ${unresolved} reported as inconclusive`,
	)
	lines.push("")
	return { failures: failed.length, text: lines.join("\n") }
}

export interface PrecisionCase {
	seed: number
	findings: Array<{ check: string; entity: string; summary: string }>
	inconclusive: number
	error?: string
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
export async function runPrecision(
	options: { cases?: number; backend?: Backend; dialect?: string; seed?: number } = {},
): Promise<PrecisionCase[]> {
	const { backend = "memory", cases = 50, dialect = "postgrest", seed: rootSeed = 1 } = options

	const { createMemoryServer, createPostgresServer, createSqliteServer } = await import("../reference/http.ts")
	const factory =
		backend === "memory" ? createMemoryServer : backend === "sqlite" ? createSqliteServer : createPostgresServer

	const results: PrecisionCase[] = []
	const random = rng(rootSeed)

	for (let index = 0; index < cases; index++) {
		const seed = Math.floor(random() * 1_000_000)
		const server = await factory({ defects: [], dialect })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS as PrincipalSpec[],
				seed,
				spec: `${server.url}/v1/openapi/spec`,
			})
			results.push({
				findings: result.findings
					.filter((finding) => finding.verdict !== "COVERAGE_GAP")
					.map((finding) => ({
						check: finding.check,
						entity: finding.entity ?? "",
						summary: finding.summary,
					})),
				inconclusive: result.inconclusive.length,
				seed,
			})
		} catch (error) {
			results.push({
				error: error instanceof Error ? error.message : String(error),
				findings: [],
				inconclusive: 0,
				seed,
			})
		} finally {
			await server.close()
		}
	}

	return results
}

export function renderPrecision(results: PrecisionCase[]): { text: string; failures: number } {
	const lines: string[] = []
	const bad = results.filter((r) => r.findings.length > 0 || r.error !== undefined)
	lines.push("")
	lines.push("  precision stress — correct backend, varied cohort data")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")
	for (const result of bad) {
		lines.push(`  ✗ seed ${result.seed}`)
		if (result.error !== undefined) lines.push(`      run failed: ${result.error}`)
		for (const finding of result.findings) {
			lines.push(`      false positive ${finding.check} (${finding.entity}) — ${finding.summary}`)
		}
	}
	const unresolved = results.reduce((sum, r) => sum + r.inconclusive, 0)
	lines.push("")
	lines.push(
		`  ${results.length - bad.length}/${results.length} cohorts produced no false positives` +
			` · ${unresolved} check(s) reported as inconclusive`,
	)
	lines.push("")
	return { failures: bad.length, text: lines.join("\n") }
}
