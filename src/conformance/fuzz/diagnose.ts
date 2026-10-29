/**
 * The fuzz oracle: what one run against several injected defects should have reported, and how
 * what it did report measures up. See `fuzz.ts` for why recall allows for cascades.
 */

import { blockedCheckOf } from "../../runtime/blocked-check.ts"
import type { DefectName } from "../../reference/defects/table.ts"
import { entityChecks } from "../../runtime/checks/core/registry.ts"
import { CHECKS } from "../../runtime/checks/registry.ts"
import type { RunResult } from "../../runtime/run/index.ts"
import { EXPECTED } from "../expected/table.ts"
import { acceptableOf, primaryOf } from "../matrix/expected.ts"

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
	/**
	 * Injected defects whose check stood down everywhere it ran, saying why: another defect took away
	 * all it could judge. Diagnosed correctly, and printed every time, so an excusal is never silent.
	 */
	excused: Array<{ defect: DefectName; check: string; reason: string }>
	findings: number
	ok: boolean
	error?: string
}

export interface PrecisionCase {
	seed: number
	findings: Array<{ check: string; entity: string; summary: string }>
	inconclusive: number
	error?: string
}

/** What a run reported that the diagnosis looks at. */
export type Reported = Pick<RunResult, "findings" | "inconclusive"> &
	Partial<Pick<RunResult, "checksSkipped" | "scope">>

type Finding = Reported["findings"][number]

/** What one fuzz case concluded, short of the case's own seed and defects. */
export type Diagnosis = Pick<
	FuzzCase,
	"cascaded" | "excused" | "findings" | "missed" | "ok" | "spurious" | "unresolved"
>

/** Every check id reachable from `id` by following `dependsOn`, transitively. */
export function ancestorsOf(id: string, seen: Set<string> = new Set<string>()): Set<string> {
	const check = entityChecks(CHECKS).find((candidate) => candidate.id === id)
	for (const parent of check?.dependsOn ?? []) {
		if (seen.has(parent)) continue
		seen.add(parent)
		ancestorsOf(parent, seen)
	}
	return seen
}

/* Coverage gaps describe what oat could not test, not what the backend got wrong. */
function real(finding: Finding): boolean {
	return finding.verdict !== "COVERAGE_GAP"
}

/** A finding as a precision case lists it. */
function brief(finding: Finding): PrecisionCase["findings"][number] {
	return { check: finding.check, entity: finding.entity, summary: finding.summary }
}

/** Against a correct backend, every real finding is a false positive. */
export function falsePositives(reported: Reported): PrecisionCase["findings"] {
	return reported.findings.filter(real).map(brief)
}

/** Recall and precision of one run against the defects `injected` into its backend. */
export function diagnose(injected: readonly DefectName[], reported: Reported): Diagnosis {
	const findings = reported.findings.filter(real)
	const fired = new Set(findings.map((finding) => finding.check))
	const recall = recallOf(injected, fired, {
		blocked: blockedChecks(findings),
		inconclusive: new Map(reported.inconclusive.map((entry) => [entry.check, entry.reason])),
		stoodDown: stoodDownEverywhere(reported),
	})
	/* Anything the injected set can justify — the primaries plus their documented
	 * consequences. A finding outside this union is oat inventing a defect. */
	const justified = new Set(injected.flatMap((defect) => acceptableOf(EXPECTED[defect])))
	const spurious = findings
		.filter((finding) => !justified.has(finding.check))
		.map((finding) => ({ ...brief(finding), detail: finding.detail }))
	return { ...recall, findings: findings.length, ok: recall.missed.length === 0 && spurious.length === 0, spurious }
}

/** Each check a BLOCKED credential stopped, and the finding's account of why. */
function blockedChecks(findings: readonly Finding[]): Map<string, string> {
	const blocked = new Map<string, string>()
	for (const finding of findings) {
		const check = blockedCheckOf(finding)
		if (check !== undefined && !blocked.has(check)) blocked.set(check, finding.detail)
	}
	return blocked
}

/**
 * Why each check stood down, for a check that stood down everywhere it ran: one that passed on some
 * operation had something to judge, and stays a miss.
 */
function stoodDownEverywhere(reported: Reported): Map<string, string> {
	const passed = new Set((reported.scope?.operations ?? []).flatMap((op) => op.checks.passed))
	const reasons = new Map<string, string>()
	for (const skip of reported.checksSkipped ?? []) if (!passed.has(skip.check)) reasons.set(skip.check, skip.needs)
	return reasons
}

/** Each injected defect whose primary check did not fire: cascaded, unresolved, or missed. */
function recallOf(
	injected: readonly DefectName[],
	fired: ReadonlySet<string>,
	stated: {
		blocked: ReadonlyMap<string, string>
		inconclusive: ReadonlyMap<string, string>
		stoodDown: ReadonlyMap<string, string>
	},
): Pick<FuzzCase, "cascaded" | "excused" | "missed" | "unresolved"> {
	const recall: Pick<FuzzCase, "cascaded" | "excused" | "missed" | "unresolved"> = {
		cascaded: [],
		excused: [],
		missed: [],
		unresolved: [],
	}
	for (const defect of injected) {
		const want = primaryOf(EXPECTED[defect])
		if (fired.has(want)) continue
		/* Not fired. Acceptable in three cases: something `want` depends on is itself broken —
		 * cascade suppression working —, the check ran and reported *why* it could not conclude
		 * (inconclusive, or BLOCKED by a credential another defect took away), or it stood down
		 * everywhere it ran, saying why. Anything else is oat going quiet, which is the real failure. */
		const broken = [...ancestorsOf(want)].find((ancestor) => fired.has(ancestor))
		const reason = stated.inconclusive.get(want) ?? stated.blocked.get(want)
		const stood = stated.stoodDown.get(want)
		if (broken !== undefined) recall.cascaded.push({ because: broken, defect })
		else if (reason !== undefined) recall.unresolved.push({ defect, reason })
		else if (stood !== undefined) recall.excused.push({ check: want, defect, reason: stood })
		else recall.missed.push({ defect, primary: want })
	}
	return recall
}
