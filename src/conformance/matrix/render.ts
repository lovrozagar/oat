import { CHECKS } from "../../runtime/checks/registry.ts"
import { EXPECTED_INCONCLUSIVE } from "../expected-failures.ts"
import type { CaseResult } from "./cases.ts"
import type { Backend } from "./engines.ts"
import { judgedOperations } from "./expected.ts"

/**
 * How many checks must actually run against each shape.
 *
 * The recurring bug in this tool has been a check that cannot *express* a request looking exactly
 * like a backend that ignores one: gating on a `page` parameter against an offset-paged API, or on
 * a `filter` parameter against one that filters per field. Every instance was found by adding a
 * new dialect and noticing the number drop — which only works if someone is looking.
 *
 * These floors make it automatic. They are deliberately set at the current coverage, so any change
 * that quietly stops a check from applying fails the suite and names it, rather than waiting for a
 * sixth dialect to expose the same class again. Raising a floor when coverage genuinely improves
 * is the intended maintenance; lowering one needs a reason stated in the commit.
 */
export const COVERAGE_FLOOR: Record<string, number> = {
	classic: 80,
	jsonapi: 87,
	linked: 89,
	plain: 71,
	postgrest: 90,
}

/** Every registered check, by id. */
function allCheckIds(): string[] {
	return CHECKS.map((check) => check.id)
}

/** A leg's answer, from its results in order: the two baselines first, then its defects. */
export function passAnswer(
	results: CaseResult[],
	backend: Backend,
	dialect: string,
): {
	text: string
	failures: number
	proven: string[]
	baselines: { tagged: string[]; untagged: string[] }
	primaryOps: Record<string, string[]>
} {
	const rendered = renderSuite(results, dialect, backend)
	const primaryOps: Record<string, string[]> = {}
	/* Every operation the primary check judged, not the first finding's alone: a defect seen on two
	 * entities is reported twice in no fixed order, and a targeted run must cover the one it shows on. */
	for (const result of results) {
		const operations = judgedOperations(result.findings, result.expected)
		if (result.defect !== null && operations.length > 0) primaryOps[result.defect] = operations
	}
	return {
		baselines: { tagged: results[0]?.checksRun ?? [], untagged: results[1]?.checksRun ?? [] },
		failures: rendered.failures,
		primaryOps,
		proven: [...rendered.proven],
		text: rendered.text,
	}
}

/** What the run found wrong with one case, beyond the verdict itself. */
interface Judged {
	ok: boolean
	isBaseline: boolean
	/** A tagged baseline that ran fewer checks than its shape's floor. */
	vacuous: boolean
	floor: number
	leaked: number
	/** Inconclusive verdicts no entry in `EXPECTED_INCONCLUSIVE` allows. */
	undecided: string[]
	bystanders: string[]
	strayLedger: string[]
	missingValues: string[]
	unreported: string[]
}

type Measured = Omit<Judged, "ok">

/** Inconclusive verdicts a clean baseline may return, per `backend:dialect`; see `expected-failures.ts`. */
type Allowance = Readonly<Record<string, readonly string[]>>

/** Judges one case of a leg on `backend` under `dialect`. */
function judge(result: CaseResult, leg: { dialect: string; backend: Backend; inconclusive: Allowance }): Judged {
	const { backend, dialect } = leg
	/*
	 * A baseline that reports nothing because it ran nothing is not evidence of precision — and a
	 * baseline that runs *fewer checks than this shape is known to support* is a coverage
	 * regression wearing a clean result's clothes.
	 */
	const floor = COVERAGE_FLOOR[dialect] ?? 10
	/* A clean baseline that could not decide a check has not shown that check passes. Only a
	 * verdict declared expected for this backend and shape may stand. */
	const variant = result.label === "baseline (untagged spec)" ? ":untagged" : ""
	const allowed = leg.inconclusive[`${backend}:${dialect}${variant}`] ?? []
	const measured: Measured = {
		bystanders: result.bystanders ?? [],
		floor,
		isBaseline: result.defect === null,
		leaked: result.leaked ?? 0,
		missingValues: result.missingValues ?? [],
		strayLedger: result.strayLedger ?? [],
		undecided: (result.inconclusive ?? []).filter((entry) => !allowed.some((prefix) => entry.startsWith(`${prefix}:`))),
		unreported: result.unreported ?? [],
		/* Only the *tagged* baseline is held to the floor. The untagged case deliberately strips
		 * every x-* tag to prove oat degrades gracefully without them, so running fewer checks
		 * there is the result being measured, not a regression. */
		vacuous: result.label === "baseline (correct backend)" && result.checksRun.length < floor,
	}
	const holds = measured.isBaseline ? baselineHolds(result, measured) : defectHolds(result)
	return { ...measured, ok: tidy(measured) && holds }
}

/** Nothing touched, ledgered, invented, or left behind unreported. */
function tidy(measured: Measured): boolean {
	return (
		measured.bystanders.length === 0 &&
		measured.strayLedger.length === 0 &&
		measured.missingValues.length === 0 &&
		measured.unreported.length === 0
	)
}

function baselineHolds(result: CaseResult, measured: Measured): boolean {
	return (
		result.spurious.length === 0 &&
		!measured.vacuous &&
		measured.leaked === 0 &&
		measured.undecided.length === 0 &&
		/* An untagged run that finds nothing *and* runs almost nothing proves nothing. */
		result.checksRun.length >= 10
	)
}

function defectHolds(result: CaseResult): boolean {
	return result.detected && result.spurious.length === 0
}

/** The detected column: how a baseline read, or whether the defect was caught. */
function detectedLabel(result: CaseResult, judged: Judged): string {
	if (!judged.isBaseline) return result.detected ? "yes" : "NO"
	if (judged.vacuous) return "VACUOUS"
	return result.spurious.length === 0 ? "clean" : "noisy"
}

/** The case's row in the table. */
function caseRow(result: CaseResult, judged: Judged): string {
	const mark = judged.ok ? "✓" : "✗"
	const detected = detectedLabel(result, judged)
	const coverage = judged.isBaseline ? `${result.checksRun.length} checks` : (result.expected ?? "—")
	return `  ${mark} ${result.label.padEnd(26)} ${detected.padEnd(8)} ${String(result.spurious.length).padEnd(9)} ${coverage}`
}

/** What the run did to the system under test that it must not. */
function litterNotes(judged: Judged): string[] {
	const { bystanders, leaked, missingValues, strayLedger, unreported } = judged
	const notes: string[] = []
	if (bystanders.length > 0)
		notes.push(`      touched ${bystanders.length} record(s) it did not create: ${bystanders.slice(0, 4).join("; ")}`)
	if (strayLedger.length > 0)
		notes.push(
			`      ledgered ${strayLedger.length} id(s) the server never created: ${strayLedger.slice(0, 4).join("; ")}`,
		)
	if (missingValues.length > 0)
		notes.push(`      would have sent a value it did not have: ${missingValues.slice(0, 4).join("; ")}`)
	if (unreported.length > 0)
		notes.push(
			`      left ${unreported.length} record(s) behind without reporting them: ${unreported.slice(0, 4).join("; ")}`,
		)
	if (leaked > 0)
		notes.push(`      left ${leaked} record(s) behind after teardown — a run must not litter the system under test`)
	return notes
}

/** Why a baseline ran too little to count, and which checks it left out. */
function vacuousNotes(result: CaseResult, judged: Judged): string[] {
	if (!judged.vacuous) return []
	const notes = [
		`      only ${result.checksRun.length} check(s) ran, below the ${judged.floor} this shape ` +
			"supports — a check that stopped applying reads exactly like a clean result",
	]
	/* Every floor is below the registry's size, so a vacuous baseline always left some out. */
	const missing = allCheckIds().filter((id) => !result.checksRun.includes(id))
	notes.push(`      did not run: ${missing.join(", ")}`)
	return notes
}

/** The lines under a case's row: everything that made it fail, in a fixed order. */
function caseNotes(result: CaseResult, judged: Judged): string[] {
	const notes = litterNotes(judged)
	for (const entry of judged.isBaseline ? judged.undecided : []) {
		notes.push(`      inconclusive on a correct backend: ${entry}`)
	}
	notes.push(...vacuousNotes(result, judged))
	if (result.error !== undefined) notes.push(`      error: ${result.error}`)
	for (const finding of result.spurious.slice(0, 4)) {
		notes.push(`      spurious: [${finding.check}] ${finding.summary}`)
	}
	if (!judged.isBaseline && !result.detected && result.error === undefined) {
		const others = result.findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		notes.push(`      missed — reported instead: ${others.map((f) => f.check).join(", ") || "nothing"}`)
	}
	return notes
}

/** Recall, precision and the pass count under the table. */
function summaryLines(results: CaseResult[], failures: number): string[] {
	const detectionCases = results.filter((r) => r.defect !== null)
	const detected = detectionCases.filter((r) => r.detected).length
	const baseline = results.find((r) => r.defect === null)
	return [
		"",
		`  recall     ${detected}/${detectionCases.length} injected defects detected`,
		`  precision  ${baseline?.spurious.length === 0 ? "clean baseline — no findings against a correct backend" : `${baseline?.spurious.length ?? 0} false positive(s) on the correct backend`}`,
		`  ${results.length - failures}/${results.length} cases passed`,
		"",
	]
}

/* A check is proven by having fired against a defect built for it — not by appearing on a
 * list of checks a defect may trip. Whether every registered check is proven is decided over
 * the whole run, since some defects only exist in some shapes. */
function provenChecks(results: CaseResult[]): Set<string> {
	return new Set(
		results
			.filter((r) => r.defect !== null && r.detected)
			.flatMap((r) => r.findings.filter((f) => f.verdict !== "COVERAGE_GAP").map((f) => f.check)),
	)
}

export function renderSuite(
	results: CaseResult[],
	dialect = "postgrest",
	backend: Backend = "memory",
	inconclusive: Allowance = EXPECTED_INCONCLUSIVE,
): { text: string; failures: number; proven: Set<string> } {
	const lines = [
		"",
		"  defect                     detected  spurious  expected check",
		"  ─────────────────────────────────────────────────────────────────────────",
	]
	let failures = 0
	for (const result of results) {
		const judged = judge(result, { backend, dialect, inconclusive })
		if (!judged.ok) failures++
		lines.push(caseRow(result, judged), ...caseNotes(result, judged))
	}
	lines.push(...summaryLines(results, failures))
	return { failures, proven: provenChecks(results), text: lines.join("\n") }
}

/** Registered checks no injected defect made fire anywhere in the run. Each one fails the suite. */
export function renderUnproven(proven: ReadonlySet<string>): { text: string; failures: number } {
	const ids = allCheckIds()
	const unproven = ids.filter((id) => !proven.has(id))
	if (unproven.length === 0) {
		return {
			failures: 0,
			text: `\n  every one of ${ids.length} registered checks fired on a defect built for it\n`,
		}
	}
	const lines = ["", `  ✗ ${unproven.length} registered check(s) never fired on an injected defect:`]
	for (const id of unproven) lines.push(`      ${id}`)
	lines.push("    a check never shown to detect anything proves nothing by passing — give it a defect or delete it")
	lines.push("")
	return { failures: unproven.length, text: lines.join("\n") }
}
