/**
 * The correct-backend shape matrix.
 *
 * The defect matrix asks whether oat notices a broken backend. This asks the opposite question,
 * which the defect matrix cannot: whether oat stays quiet on a *correct* backend shaped unlike the
 * one it was written against. Each case serves the clean reference behind one shape and requires
 * nothing from oat at all — no finding, no inconclusive verdict, no record left behind, and no
 * check that quietly stopped applying.
 *
 * Cases oat still gets wrong are listed in `expected-failures.ts`, which may only shrink.
 */

import type { Backend } from "./suite.ts"
import { EXPECTED_FAILURES } from "./expected-failures.ts"
import { damagedBystanders, leftBehind, ledgeredNotCreated } from "./leaks.ts"
import { PRINCIPALS, defectsFor, judgeDefect } from "./suite.ts"
import { type DefectName, isDefectName } from "../reference/defects.ts"
import { SHAPES } from "../reference/shapes.ts"
import { run } from "../runtime/run/index.ts"

export interface ShapeCase {
	label: string
	why: string
	/** Everything that makes this case fail; empty when oat handled the shape. */
	problems: string[]
	/** Why the case is known to fail, when it is listed in `expected-failures.ts`. */
	expected: string | undefined
}

async function factoryFor(backend: Backend) {
	const http = await import("../reference/http.ts")
	return backend === "sqlite"
		? http.createSqliteServer
		: backend === "postgres"
			? http.createPostgresServer
			: http.createMemoryServer
}

/** One clean run behind `shape`, reduced to what it got wrong. */
async function judge(
	backend: Backend,
	shape: string | undefined,
	reference: ReadonlySet<string> | undefined,
	cannotRun: Readonly<Record<string, string>> = {},
): Promise<{ problems: string[]; checksRun: string[] }> {
	const factory = await factoryFor(backend)
	const server = await factory(shape === undefined ? {} : { shape })
	try {
		const before = await server.snapshot()
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const problems: string[] = []
		for (const finding of result.findings) {
			if (finding.verdict === "COVERAGE_GAP") continue
			problems.push(`${finding.verdict} [${finding.check}] ${finding.entity}: ${finding.summary}`)
		}
		for (const item of result.inconclusive) {
			problems.push(`inconclusive [${item.check}] ${item.entity}: ${item.reason}`)
		}
		for (const create of result.teardown?.unidentified ?? []) {
			problems.push(`left a record it could not identify: ${create.operationId} → ${create.status} (#${create.seq})`)
		}
		const after = await server.snapshot()
		const leaked = leftBehind(before, after)
		if (leaked.length > 0) {
			problems.push(`left ${leaked.length} record(s) behind: ${leaked.slice(0, 4).join(", ")}`)
		}
		const bystanders = damagedBystanders(before, after)
		if (bystanders.length > 0) {
			problems.push(`touched ${bystanders.length} record(s) it did not create: ${bystanders.slice(0, 4).join("; ")}`)
		}
		const stray = ledgeredNotCreated(result.teardown?.records ?? [], server.createdIds())
		if (stray.length > 0) {
			problems.push(`ledgered ${stray.length} id(s) the server never created: ${stray.slice(0, 4).join("; ")}`)
		}
		if (reference !== undefined) {
			const missing = [...reference].filter((id) => !result.checksRun.includes(id) && !Object.hasOwn(cannotRun, id))
			if (missing.length > 0) {
				problems.push(`${missing.length} check(s) stopped applying: ${missing.join(", ")}`)
			}
		}
		return { checksRun: result.checksRun, problems }
	} finally {
		await server.close()
	}
}

/** Every shape the reference serves, by name, in order. */
export const SHAPE_NAMES: readonly string[] = SHAPES.map((named) => named.name)

/**
 * The checks a clean run behind the default shape runs: what every other shape must also run.
 * `null` when the default shape cannot be run at all, and then no shape is held to it.
 */
export async function shapeReference(backend: Backend = "memory"): Promise<string[] | null> {
	try {
		return (await judge(backend, undefined, undefined)).checksRun
	} catch {
		return null
	}
}

/** One shape, judged against the default shape's checks. */
export async function judgeShape(
	backend: Backend,
	name: string,
	reference: readonly string[] | null,
): Promise<ShapeCase> {
	const named = SHAPES.find((candidate) => candidate.name === name)
	if (named === undefined) throw new Error(`no shape "${name}"`)
	const label = `shape:${name}`
	let problems: string[]
	try {
		problems = (await judge(backend, name, reference === null ? undefined : new Set(reference), named.cannotRun))
			.problems
	} catch (error) {
		problems = [`threw: ${error instanceof Error ? error.message : String(error)}`]
	}
	return { expected: EXPECTED_FAILURES[label], label, problems, why: named.why }
}

export function renderShapeSuite(cases: ShapeCase[], quiet = false): { text: string; failures: number } {
	const lines = ["", "  case                                           result", `  ${"─".repeat(73)}`]
	let failures = 0
	for (const item of cases) {
		const passed = item.problems.length === 0
		if (passed && item.expected === undefined) {
			/* Hundreds of recall cases pass; listing each buries the ones that do not. */
			if (!quiet) lines.push(`  ✓ ${item.label.padEnd(28)} clean — ${item.why}`)
		} else if (!passed && item.expected !== undefined) {
			lines.push(`  ✓ ${item.label.padEnd(28)} known failure — ${item.expected}`)
		} else if (passed) {
			failures++
			lines.push(`  ✗ ${item.label.padEnd(28)} now passes — remove it from expected-failures.ts`)
		} else {
			failures++
			lines.push(`  ✗ ${item.label.padEnd(28)} ${item.why}`)
			for (const problem of item.problems.slice(0, 6)) lines.push(`      ${problem}`)
			if (item.problems.length > 6) lines.push(`      … ${item.problems.length - 6} more`)
		}
	}
	const known = cases.filter((item) => item.expected !== undefined && item.problems.length > 0).length
	lines.push("")
	lines.push(`  ${cases.length - failures}/${cases.length} cases as expected · ${known} known failure(s)`)
	lines.push("")
	return { failures, text: lines.join("\n") }
}

/**
 * Every defect again, behind each shape oat already handles.
 *
 * A clean baseline behind a shape says oat is quiet there; it does not say oat still *sees*
 * anything. Mounting the API under a prefix once cost five detections while the clean run stayed
 * spotless. Behind a shape whose clean baseline still fails, recall cannot mean anything yet, so
 * that shape reports one case that waits on the shape itself (`waitingRecall`).
 */
export function recallDefects(backend: Backend, name: string): DefectName[] {
	const named = SHAPES.find((candidate) => candidate.name === name)
	if (named === undefined) return []
	const skip = new Set(named.cannotExhibit ?? [])
	const own = (named.exhibits ?? []).filter((defect): defect is DefectName => isDefectName(defect))
	return [...defectsFor(backend, "postgrest").filter((candidate) => !skip.has(candidate)), ...own]
}

/** The one recall case of a shape that does not run clean yet. */
export function waitingRecall(shapeCase: ShapeCase): ShapeCase {
	const name = shapeCase.label.replace(/^shape:/, "")
	return {
		expected: shapeCase.expected,
		label: `recall:${name}`,
		problems: [`waits for shape:${name}, which does not run clean yet`],
		why: shapeCase.why,
	}
}

/** Recall of `defects` behind the shape `name`: a case per defect. */
export async function recallBehind(
	backend: Backend,
	name: string,
	defects: readonly DefectName[],
): Promise<ShapeCase[]> {
	const cases: ShapeCase[] = []
	for (const defect of defects) {
		const label = `recall:${name}:${defect}`
		const result = await judgeDefect(defect, backend, "postgrest", name, label)
		cases.push({
			expected: EXPECTED_FAILURES[label],
			label,
			problems: recallProblems(result),
			why: `${defect} behind ${name}`,
		})
	}
	return cases
}

/** What a recall run got wrong: a miss, a spurious finding, a value it lacked, a record it left. */
function recallProblems(result: Awaited<ReturnType<typeof judgeDefect>>): string[] {
	const problems: string[] = []
	if (result.error !== undefined) problems.push(`error: ${result.error}`)
	else if (!result.detected) {
		const fired = result.findings.filter((f) => f.verdict !== "COVERAGE_GAP").map((f) => f.check)
		problems.push(`missed ${result.expected ?? ""} — reported instead: ${fired.join(", ") || "nothing"}`)
	}
	for (const finding of result.spurious.slice(0, 3))
		problems.push(`spurious [${finding.check}] ${finding.entity}: ${finding.summary}`)
	for (const where of (result.missingValues ?? []).slice(0, 3))
		problems.push(`would have sent a value it did not have: ${where}`)
	const unreported = result.unreported ?? []
	if (unreported.length > 0) {
		problems.push(
			`left ${unreported.length} record(s) behind without reporting them: ${unreported.slice(0, 4).join("; ")}`,
		)
	}
	return problems
}
