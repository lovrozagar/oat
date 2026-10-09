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
import { leftBehind } from "./leaks.ts"
import { PRINCIPALS, defectsFor, judgeDefect } from "./suite.ts"
import { SHAPES } from "../reference/shapes.ts"
import { run } from "../runtime/run.ts"

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
		const leaked = leftBehind(before, await server.snapshot())
		if (leaked.length > 0) {
			problems.push(`left ${leaked.length} record(s) behind: ${leaked.slice(0, 4).join(", ")}`)
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

export async function runShapeSuite(backend: Backend = "memory", only?: readonly string[]): Promise<ShapeCase[]> {
	/* The default shape first: what it runs is what every other shape must also run. */
	let reference: ReadonlySet<string> | undefined
	try {
		reference = new Set((await judge(backend, undefined, undefined)).checksRun)
	} catch {
		reference = undefined
	}
	const cases: ShapeCase[] = []
	for (const named of SHAPES) {
		if (only !== undefined && only.length > 0 && !only.includes(named.name)) continue
		const label = `shape:${named.name}`
		let problems: string[]
		try {
			problems = (await judge(backend, named.name, reference, named.cannotRun)).problems
		} catch (error) {
			problems = [`threw: ${error instanceof Error ? error.message : String(error)}`]
		}
		cases.push({ expected: EXPECTED_FAILURES[label], label, problems, why: named.why })
	}
	return cases
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
 * those shapes report one case that waits on the shape itself.
 */
export async function runShapeRecall(backend: Backend, shapes: readonly ShapeCase[]): Promise<ShapeCase[]> {
	const cases: ShapeCase[] = []
	for (const shapeCase of shapes) {
		const name = shapeCase.label.replace(/^shape:/, "")
		const named = SHAPES.find((candidate) => candidate.name === name)
		if (named === undefined) continue
		if (shapeCase.problems.length > 0) {
			cases.push({
				expected: shapeCase.expected,
				label: `recall:${name}`,
				problems: [`waits for shape:${name}, which does not run clean yet`],
				why: named.why,
			})
			continue
		}
		const skip = new Set(named.cannotExhibit ?? [])
		for (const defect of defectsFor(backend, "postgrest").filter((candidate) => !skip.has(candidate))) {
			const label = `recall:${name}:${defect}`
			const result = await judgeDefect(defect, backend, "postgrest", name, label)
			const problems: string[] = []
			if (result.error !== undefined) problems.push(`error: ${result.error}`)
			else if (!result.detected) {
				const fired = result.findings.filter((f) => f.verdict !== "COVERAGE_GAP").map((f) => f.check)
				problems.push(`missed ${result.expected ?? ""} — reported instead: ${fired.join(", ") || "nothing"}`)
			}
			for (const finding of result.spurious.slice(0, 3)) {
				problems.push(`spurious [${finding.check}] ${finding.entity}: ${finding.summary}`)
			}
			cases.push({ expected: EXPECTED_FAILURES[label], label, problems, why: `${defect} behind ${name}` })
		}
	}
	return cases
}
